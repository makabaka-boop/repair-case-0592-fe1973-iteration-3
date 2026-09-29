"""三探头中位致死量积分。

三支探头的采样时刻不必一致，但都从 0 秒开始、结束于同一秒，且各自满足
单探头的时间/温度/间隔校验（由 validation 负责）。

中位原则：在**每个时刻**取三支探头致死速率的中位值（排序后的第二支）形成
中位曲线再积分，而不是对三份总 F₀ 取中位数——后者会掩盖单支探头在局部
时间段内的异常。

插值口径与单/双探头一致：每支探头在各自采样点之间是分段线性的致死速率线。
在三探头采样时刻的并集上，额外收集**每一对**速率线的内部交点作为切分点：
三条直线的中位函数只在某两条线相交时换源，因此这些切分点足以保证每个子
区间内中位来源恒定，区间内按梯形法积分在解析上精确。

裁决规则（必须固定、可复现）：
- 交点重合（含三条线交于同一时刻）：合并为同一个边界，不产生零时长片段；
- 曲线重叠/并列中位：按固定探头顺序 probeA → probeB → probeC 取最前者
  作为该段来源探头，并列集合通过 tie/裁决依据完整返回；
- 交点恰落在并集采样时刻上时不另拆零长度段。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .lethality import (
    THRESHOLD_MINUTES,
    round_half_up,
)
from .lethality_dual import (
    RATE_EPS,
    ProbeCurve,
    SOURCE_A,
    SOURCE_B,
    _classify_side,
    _probe_curve,
    _rates_close,
    _sample_rate_at,
)

SOURCE_C = "probeC"
# 固定探头顺序：所有并列/重合裁决都按此顺序取最前者
PROBE_ORDER = (SOURCE_A, SOURCE_B, SOURCE_C)
PROBE_INDEX = {probe: i for i, probe in enumerate(PROBE_ORDER)}
PROBE_LABELS = {SOURCE_A: "探头A", SOURCE_B: "探头B", SOURCE_C: "探头C"}

# 同一并集区间内，两个内部交点的归一化位置差小于此值即视为“交点重合”：
# 区间最长 60 s，对应时间差 < 6e-8 s，远小于任何业务可分辨量，同时避免
# 浮点尾噪制造 ~1e-14 s 的零时长碎段
FRACTION_EPS = 1e-9


@dataclass(frozen=True)
class MedianSegment:
    """中位曲线被并集时刻/两两交点切出的一段。"""

    index: int  # 1-based 段号
    start_time: float
    end_time: float
    duration_seconds: float
    source: str  # probeA/probeB/probeC：固定顺序裁决后本段中位取自哪支探头
    tie: tuple[str, ...]  # 与 source 并列中位的全部探头（含 source 自身）
    start_order: tuple[str, ...]  # 本段起点速率由低到高的探头顺序（并列按固定顺序）
    end_order: tuple[str, ...]
    reason: str  # 本段为何由 source 贡献（中段排序 + 并列裁决的中文说明）
    start_rate: float  # 中位速率在本段起止的值
    end_rate: float
    rate_a_start: float  # 三支探头各自在本段起止的速率（图形/明细同源）
    rate_a_end: float
    rate_b_start: float
    rate_b_end: float
    rate_c_start: float
    rate_c_end: float
    contribution: float  # 未舍入的段贡献（分钟）


@dataclass(frozen=True)
class TripleLethalityResult:
    probe_a: ProbeCurve
    probe_b: ProbeCurve
    probe_c: ProbeCurve
    segments: list[MedianSegment]
    median_unrounded: float  # 中位总量（未舍入）
    median_f0: float  # 四舍五入到两位小数（仅展示）
    threshold: float
    passed: bool  # 用**未舍入**的中位总量与门槛比较
    shortfall: float | None  # 未达标时距门槛的差额（未舍入，分钟）


def _rate_groups(values: dict[str, float]) -> list[list[str]]:
    """把三支探头按速率由低到高分组。

    同组速率在相对容差内相等（曲线重合/交点并列），组内探头保持固定顺序
    A→B→C；不同组按组内最小速率排序。返回分组列表，每组为探头名列表。
    """
    groups: list[list[str]] = []
    for probe in PROBE_ORDER:
        for group in groups:
            if any(_rates_close(values[probe], values[other]) for other in group):
                group.append(probe)
                break
        else:
            groups.append([probe])
    groups.sort(key=lambda group: min(values[p] for p in group))
    return groups


def _flatten(groups: list[list[str]]) -> tuple[str, ...]:
    return tuple(probe for group in groups for probe in group)


def _median_group(groups: list[list[str]]) -> list[str]:
    """三支探头排序后第 2 位所在的组，即并列中位的全部探头。"""
    flat = _flatten(groups)
    middle = flat[1]
    return next(group for group in groups if middle in group)


def _rank_text(probes: list[str]) -> str:
    return " = ".join(PROBE_LABELS[p] for p in probes)


def _segment_reason(groups: list[list[str]], source: str) -> str:
    """说明本段中位为何来自 source：中段速率排序 + 并列时的固定顺序裁决。"""
    order_text = " < ".join(_rank_text(group) for group in groups)
    if len(groups) == 3:
        return f"中段速率由低到高：{order_text}；中位曲线为{PROBE_LABELS[source]}"
    tie = _median_group(groups)
    tie_names = "、".join(PROBE_LABELS[p] for p in tie)
    return (
        f"中段速率由低到高：{order_text}；中位在{tie_names}间并列，"
        f"按固定顺序 A→B→C 裁决取{PROBE_LABELS[source]}"
    )


@dataclass(frozen=True)
class _Boundary:
    time: float
    rates: tuple[float, float, float]  # 三探头在该边界的速率（交点处已抹平）


def _blend_crossing_rates(
    rates: list[float], pairs: list[tuple[int, int]]
) -> tuple[float, float, float]:
    """交点边界处，把相交线对的速率取平均抵消插值尾噪。

    重合交点可能同时包含两对（三条线汇于一点），用并查集把相连线对并入
    同一组，组内速率统一取均值；不参与相交的探头保持自身插值。
    """
    parent = list(range(3))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in pairs:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    components: dict[int, list[int]] = {}
    for i in range(3):
        components.setdefault(find(i), []).append(i)

    out = list(rates)
    for members in components.values():
        if len(members) > 1:
            average = sum(out[k] for k in members) / len(members)
            for k in members:
                out[k] = average
    return out[0], out[1], out[2]


def _merge_crossing_events(
    events: list[tuple[float, tuple[int, int]]],
) -> list[tuple[float, tuple[tuple[int, int], ...]]]:
    """合并归一化位置重合的交点（不同线对在同一时刻穿越）。"""
    events = sorted(events, key=lambda event: event[0])
    merged: list[list] = []
    for fraction, pair in events:
        if merged and abs(fraction - merged[-1][0]) < FRACTION_EPS:
            merged[-1][1].append(pair)
            # 重合位置取均值（二者差已小于 FRACTION_EPS）
            merged[-1][0] = (merged[-1][0] + fraction) / 2.0
        else:
            merged.append([fraction, [pair]])
    return [(fraction, tuple(pairs)) for fraction, pairs in merged]


def _median_value(rates: tuple[float, float, float]) -> float:
    return sorted(rates)[1]


def _median_pieces(
    points_map: dict[str, list[tuple[int, float]]],
) -> list[dict]:
    """在三探头采样时刻并集 + 两两内部交点上切出中位曲线段。"""
    union_times = sorted(
        {float(t) for probe in PROBE_ORDER for t, _ in points_map[probe]}
    )

    pieces: list[dict] = []
    for left, right in zip(union_times, union_times[1:]):
        rates_left: list[float] = [
            _sample_rate_at(points_map[PROBE_ORDER[i]], left) for i in range(3)
        ]
        rates_right: list[float] = [
            _sample_rate_at(points_map[PROBE_ORDER[i]], right) for i in range(3)
        ]

        # 收集三对线在本区间内部的穿越点；端点穿越（差值在端点容差为 0）
        # 不产生内部边界，归属由相邻区间的中段排序决定，与双探头口径一致。
        events: list[tuple[float, tuple[int, int]]] = []
        for i, j in ((0, 1), (0, 2), (1, 2)):
            d_left = rates_left[i] - rates_left[j]
            d_right = rates_right[i] - rates_right[j]
            side_left, side_right = _classify_side(d_left, d_right)
            if side_left != 0 and side_right != 0 and side_left != side_right:
                denom = d_left - d_right
                fraction = d_left / denom if denom != 0.0 else 0.5
                fraction = min(1.0, max(0.0, fraction))
                if FRACTION_EPS < fraction < 1.0 - FRACTION_EPS:
                    events.append((fraction, (i, j)))

        boundaries: list[_Boundary] = [
            _Boundary(left, tuple(rates_left))  # type: ignore[arg-type]
        ]
        for fraction, pairs in _merge_crossing_events(events):
            interpolated = [
                rates_left[k]
                + (rates_right[k] - rates_left[k]) * fraction
                for k in range(3)
            ]
            blended = _blend_crossing_rates(interpolated, list(pairs))
            boundaries.append(
                _Boundary(left + fraction * (right - left), blended)
            )
        boundaries.append(_Boundary(right, tuple(rates_right)))  # type: ignore[arg-type]

        for boundary, next_boundary in zip(boundaries, boundaries[1:]):
            duration = next_boundary.time - boundary.time
            if duration <= 0.0:
                # 重合交点已合并；任何残余的非正时长片段一律不输出
                continue

            mid_values = {
                probe: (boundary.rates[k] + next_boundary.rates[k]) / 2.0
                for k, probe in enumerate(PROBE_ORDER)
            }
            mid_groups = _rate_groups(mid_values)
            tie_group = _median_group(mid_groups)
            source = tie_group[0]  # 并列中位：固定顺序取最前者
            reason = _segment_reason(mid_groups, source)

            start_groups = _rate_groups(
                {probe: boundary.rates[k] for k, probe in enumerate(PROBE_ORDER)}
            )
            end_groups = _rate_groups(
                {
                    probe: next_boundary.rates[k]
                    for k, probe in enumerate(PROBE_ORDER)
                }
            )

            med_start = _median_value(boundary.rates)
            med_end = _median_value(next_boundary.rates)
            contribution = (
                (med_start + med_end) / 2.0 * duration / 60.0
            )

            pieces.append(
                {
                    "start_time": float(boundary.time),
                    "end_time": float(next_boundary.time),
                    "duration_seconds": float(duration),
                    "source": source,
                    "tie": tuple(tie_group),
                    "start_order": _flatten(start_groups),
                    "end_order": _flatten(end_groups),
                    "reason": reason,
                    "start_rate": med_start,
                    "end_rate": med_end,
                    "rate_a_start": boundary.rates[0],
                    "rate_a_end": next_boundary.rates[0],
                    "rate_b_start": boundary.rates[1],
                    "rate_b_end": next_boundary.rates[1],
                    "rate_c_start": boundary.rates[2],
                    "rate_c_end": next_boundary.rates[2],
                    "contribution": contribution,
                }
            )

    return pieces


def compute_triple_lethality(
    points_a: list[tuple[int, float]],
    points_b: list[tuple[int, float]],
    points_c: list[tuple[int, float]],
) -> TripleLethalityResult:
    """计算三支探头逐时刻中位速率的致死量，并保留各自总量与逐段来源裁决。"""
    points_map = {
        SOURCE_A: points_a,
        SOURCE_B: points_b,
        SOURCE_C: points_c,
    }
    for probe in PROBE_ORDER:
        if len(points_map[probe]) < 2:
            raise ValueError("每支探头至少需要两个采样点")
        if points_map[probe][0][0] != 0:
            raise ValueError("三支探头都必须从 0 秒开始")
    end_seconds = {points_map[probe][-1][0] for probe in PROBE_ORDER}
    if len(end_seconds) != 1:
        raise ValueError("三支探头必须结束于同一秒")

    probe_a = _probe_curve(SOURCE_A, points_a)
    probe_b = _probe_curve(SOURCE_B, points_b)
    probe_c = _probe_curve(SOURCE_C, points_c)

    raw_pieces = _median_pieces(points_map)
    segments: list[MedianSegment] = []
    total = 0.0
    for index, piece in enumerate(raw_pieces, start=1):
        total += piece["contribution"]  # 未舍入累加
        segments.append(MedianSegment(index=index, **piece))

    f0_decimal = round_half_up(total)
    threshold = THRESHOLD_MINUTES
    # 放行只用未舍入的中位总量与原门槛比较（不看四舍五入后的展示值）
    passed = Decimal(str(total)) >= threshold
    shortfall = None if passed else float(threshold) - total
    return TripleLethalityResult(
        probe_a=probe_a,
        probe_b=probe_b,
        probe_c=probe_c,
        segments=segments,
        median_unrounded=total,
        median_f0=float(f0_decimal),
        threshold=float(threshold),
        passed=passed,
        shortfall=shortfall,
    )
