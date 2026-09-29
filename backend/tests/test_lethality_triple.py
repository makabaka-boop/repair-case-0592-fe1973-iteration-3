"""三探头中位致死量测试。

覆盖：
- “手算交点样例”：手工可解的三条分段线性速率线，断言交点位置、
  来源切换、并列裁决与各段贡献；
- “独立数值预言机”：与实现无关的稠密网格逐点取中位做梯形积分，
  覆盖换源、交点重合、曲线重叠、并列中位与未舍入临界判定。
"""

from __future__ import annotations

import math

import pytest

from app.lethality import SECONDS_PER_MINUTE, lethality_rate
from app.lethality_triple import (
    PROBE_ORDER,
    SOURCE_A,
    SOURCE_B,
    SOURCE_C,
    compute_triple_lethality,
)


def temp_for_rate(rate: float) -> float:
    """给定目标致死速率反推温度：rate = 10^((T-121.1)/10)。"""
    return 121.1 + 10.0 * math.log10(rate)


def make_ramp(times: list[int], rates: list[float]) -> list[tuple[int, float]]:
    return [(t, temp_for_rate(r)) for t, r in zip(times, rates)]


# ---------------------------------------------------------------------------
# 独立预言机：10 ms 稠密网格上逐点取三条线的中位做梯形累加，
# 与被测的“交点解析拆段”算法完全不同。误差上界约为
# 每格中位速率斜率×步长²/60（约 1e-6 min），断言用 1e-3 容差。
# ---------------------------------------------------------------------------


def _linear_rate(points: list[tuple[int, float]], t: float) -> float:
    for (t0, temp0), (t1, temp1) in zip(points, points[1:]):
        if t0 <= t <= t1:
            r0, r1 = lethality_rate(temp0), lethality_rate(temp1)
            return r0 + (r1 - r0) * ((t - t0) / (t1 - t0))
    return lethality_rate(points[-1][1])


def oracle_median_total(
    points_map: dict[str, list[tuple[int, float]]],
    step_seconds: float = 0.01,
) -> float:
    end = points_map[SOURCE_A][-1][0]
    grid: list[float] = []
    t = 0.0
    while t < end - 1e-12:
        grid.append(min(t, end))
        t += step_seconds
    grid.append(float(end))
    total = 0.0
    for t0, t1 in zip(grid, grid[1:]):
        m0 = sorted(_linear_rate(points_map[p], t0) for p in PROBE_ORDER)[1]
        m1 = sorted(_linear_rate(points_map[p], t1) for p in PROBE_ORDER)[1]
        total += (m0 + m1) / 2.0 * (t1 - t0) / SECONDS_PER_MINUTE
    return total


# ---------------------------------------------------------------------------
# 手算交点样例
# ---------------------------------------------------------------------------


class TestParsedIntersections:
    def test_constant_third_probe_is_median_across_switch(self):
        # A: 1→2→3（0/30/60），B: 3→2→1，C 恒 2。
        # C 始终为中位；t=30 为三重交点。中位恒 2 ⇒ 总量 2.0，两段。
        points_a = make_ramp([0, 30, 60], [1.0, 2.0, 3.0])
        points_b = make_ramp([0, 30, 60], [3.0, 2.0, 1.0])
        points_c = make_ramp([0, 60], [2.0, 2.0])
        result = compute_triple_lethality(points_a, points_b, points_c)

        assert len(result.segments) == 2
        assert all(s.source == SOURCE_C for s in result.segments)
        assert all(s.tie == (SOURCE_C,) for s in result.segments)
        assert (result.segments[0].start_time, result.segments[0].end_time) == (
            pytest.approx(0.0),
            pytest.approx(30.0),
        )
        assert (result.segments[1].start_time, result.segments[1].end_time) == (
            pytest.approx(30.0),
            pytest.approx(60.0),
        )
        assert result.segments[0].contribution == pytest.approx(1.0)
        assert result.segments[1].contribution == pytest.approx(1.0)
        assert result.median_unrounded == pytest.approx(2.0)
        # 三支各自总量都为 2.0：若错误地取“三份总 F₀ 的中位数”结果也是 2.0，
        # 逐段来源裁决仍必须逐刻成立（这里由 C 恒贡献）
        assert result.probe_a.total_unrounded == pytest.approx(2.0)

    def test_internal_pairwise_crossings_switch_median_source(self):
        # A 恒 2；B: 1→4（B(t)=1+t/20）；C: 4→1（C(t)=4-t/20），均 [0,60]。
        # 三个交点：B=A 在 t=20，B=C 在 t=30，C=A 在 t=40，中位来源序列：
        #   [0,20]  B<A<C ⇒ A；[20,30] A<B<C ⇒ B；
        #   [30,40] A<C<B ⇒ C；[40,60] C<A<B ⇒ A。
        # 解析贡献：2×20/60=2/3；(2+2.5)/2×10/60=0.375；
        #           (2.5+2)/2×10/60=0.375；2×20/60=2/3；合计 25/12。
        points_a = make_ramp([0, 60], [2.0, 2.0])
        points_b = make_ramp([0, 60], [1.0, 4.0])
        points_c = make_ramp([0, 60], [4.0, 1.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        boundaries = [result.segments[0].start_time]
        boundaries.extend(s.end_time for s in result.segments)
        assert boundaries == pytest.approx([0.0, 20.0, 30.0, 40.0, 60.0], abs=1e-7)
        assert [s.source for s in result.segments] == [
            SOURCE_A,
            SOURCE_B,
            SOURCE_C,
            SOURCE_A,
        ]
        contributions = [s.contribution for s in result.segments]
        assert contributions == pytest.approx(
            [2.0 / 3.0, 0.375, 0.375, 2.0 / 3.0]
        )
        assert result.median_unrounded == pytest.approx(25.0 / 12.0)

    def test_median_switches_to_side_probes_through_ramp(self):
        # A: 1→5（A(t)=1+t/15，A=4 在 t=45）；
        # B: 7→1（B(t)=7-t/10，B=4 在 t=30）；C 恒 4。
        # A=B 交点：1+t/15 = 7-t/10 → t=36；三个交点 t=30/36/45，来源序列：
        # [0,30] A<4<B ⇒ C；[30,36] A<B<4 ⇒ B；
        # [36,45] B<A<4 ⇒ A；[45,60] B<4<A ⇒ C。
        # 解析贡献：4×30/60=2.0；B 4→3.4：(4+3.4)/2×6/60=0.37；
        #           A 3.4→4：(3.4+4)/2×9/60=0.555；4×15/60=1.0，合计 3.925。
        points_a = make_ramp([0, 60], [1.0, 5.0])
        points_b = make_ramp([0, 60], [7.0, 1.0])
        points_c = make_ramp([0, 60], [4.0, 4.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        boundaries = [s.end_time for s in result.segments]
        assert boundaries == pytest.approx([30.0, 36.0, 45.0, 60.0], abs=1e-7)
        assert [s.source for s in result.segments] == [
            SOURCE_C,
            SOURCE_B,
            SOURCE_A,
            SOURCE_C,
        ]
        contributions = [s.contribution for s in result.segments]
        assert contributions == pytest.approx([2.0, 0.37, 0.555, 1.0])
        assert result.median_unrounded == pytest.approx(3.925)

    def test_triple_crossing_is_single_boundary_no_zero_piece(self):
        # 三条线汇于 t=30：A 1→3，B 恒 2，C 3→1；两对（甚至三对）交点重合。
        points_a = make_ramp([0, 60], [1.0, 3.0])
        points_b = make_ramp([0, 60], [2.0, 2.0])
        points_c = make_ramp([0, 60], [3.0, 1.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert len(result.segments) == 2
        assert all(s.duration_seconds > 0 for s in result.segments)
        assert [s.end_time for s in result.segments] == pytest.approx([30.0, 60.0])
        # 交点边界处三者速率相等，顺序裁决固定为 A→B→C
        assert result.segments[0].end_order == (SOURCE_A, SOURCE_B, SOURCE_C)
        assert result.segments[1].start_order == (SOURCE_A, SOURCE_B, SOURCE_C)

    def test_two_probes_coincident_as_median_arbitrated_by_fixed_order(self):
        # A 恒 1（最低），B、C 同为恒 3（重合，并列中位）：裁 B。
        points_a = make_ramp([0, 60], [1.0, 1.0])
        points_b = make_ramp([0, 60], [3.0, 3.0])
        points_c = make_ramp([0, 30, 60], [3.0, 3.0, 3.0])  # 不同采样网格
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert all(s.source == SOURCE_B for s in result.segments)
        assert all(s.tie == (SOURCE_B, SOURCE_C) for s in result.segments)
        assert all("并列" in s.reason and "探头B" in s.reason for s in result.segments)
        assert result.median_unrounded == pytest.approx(3.0)

    def test_median_tie_between_a_and_c_arbitrated_to_a(self):
        # A、C 同为恒 1（并列最低但不当中位），B 恒 5 为最高：
        # 中位是并列最低组 A=C，固定顺序裁决取 A。
        points_a = make_ramp([0, 60], [1.0, 1.0])
        points_b = make_ramp([0, 60], [5.0, 5.0])
        points_c = make_ramp([0, 60], [1.0, 1.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert all(s.source == SOURCE_A for s in result.segments)
        assert all(s.tie == (SOURCE_A, SOURCE_C) for s in result.segments)
        assert result.median_unrounded == pytest.approx(1.0)

    def test_all_three_coincident_arbitrated_to_a(self):
        points_a = make_ramp([0, 30, 60], [2.0, 2.0, 2.0])
        points_b = make_ramp([0, 60], [2.0, 2.0])
        points_c = make_ramp([0, 15, 45, 60], [2.0, 2.0, 2.0, 2.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert all(s.source == SOURCE_A for s in result.segments)
        assert all(s.tie == (SOURCE_A, SOURCE_B, SOURCE_C) for s in result.segments)
        assert result.median_unrounded == pytest.approx(2.0)

    def test_crossing_exactly_on_shared_knot_emits_no_zero_piece(self):
        # A: 1→2→3（0/30/60），B: 3→2→1（0/30/60），C 恒 2：
        # 三重交点恰在共享采样时刻 t=30，并集切分天然包含它，无碎段。
        points_a = make_ramp([0, 30, 60], [1.0, 2.0, 3.0])
        points_b = make_ramp([0, 30, 60], [3.0, 2.0, 1.0])
        points_c = make_ramp([0, 60], [2.0, 2.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert all(s.duration_seconds > 0 for s in result.segments)
        assert [s.end_time for s in result.segments] == pytest.approx([30.0, 60.0])

    def test_partial_overlap_interval_marked_tie(self):
        # A: 3→2→3（0/20/40/60? 用三段），B 恒 2，C 恒 2：
        # [20,40] 三线重合（A 贴在 2），A 在两端翘起；中位始终是 2，
        # 重合段 tie 为三探头，固定顺序裁 A；非重合段 tie 为 B/C 裁 B。
        points_a = make_ramp([0, 20, 40, 60], [3.0, 2.0, 2.0, 3.0])
        points_b = make_ramp([0, 60], [2.0, 2.0])
        points_c = make_ramp([0, 60], [2.0, 2.0])
        result = compute_triple_lethality(points_a, points_b, points_c)
        sources = [(s.source, s.tie) for s in result.segments]
        # 端点并集时刻：0/20/40/60
        assert sources[0] == (SOURCE_B, (SOURCE_B, SOURCE_C))
        assert sources[1] == (SOURCE_A, (SOURCE_A, SOURCE_B, SOURCE_C))
        assert sources[2] == (SOURCE_B, (SOURCE_B, SOURCE_C))
        assert result.median_unrounded == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# 预言机驱动：换源 / 重合 / 错格 / 交点重合 等多组样例
# ---------------------------------------------------------------------------

ORACLE_CASES = [
    # 三探头恒值，顺序固定
    {
        SOURCE_A: make_ramp([0, 60], [1.0, 1.0]),
        SOURCE_B: make_ramp([0, 60], [2.0, 2.0]),
        SOURCE_C: make_ramp([0, 60], [3.0, 3.0]),
    },
    # 三条斜线交错（多次换源）
    {
        SOURCE_A: make_ramp([0, 60], [1.0, 7.0]),
        SOURCE_B: make_ramp([0, 20, 50, 60], [6.0, 1.0, 6.0, 1.0]),
        SOURCE_C: make_ramp([0, 30, 60], [7.0, 3.0, 7.0]),
    },
    # 错格 + 不同拐点
    {
        SOURCE_A: make_ramp([0, 20, 50, 60], [1.0, 5.0, 1.0, 5.0]),
        SOURCE_B: make_ramp([0, 15, 45, 60], [5.0, 1.0, 5.0, 1.0]),
        SOURCE_C: make_ramp([0, 30, 60], [3.0, 3.0, 3.0]),
    },
    # 三线完全重合（不同网格）
    {
        SOURCE_A: make_ramp([0, 60], [1.0, 4.0]),
        SOURCE_B: make_ramp([0, 15, 45, 60], [1.0, 1.75, 3.25, 4.0]),
        SOURCE_C: make_ramp([0, 30, 60], [1.0, 2.5, 4.0]),
    },
    # 两线重合、第三线穿越
    {
        SOURCE_A: make_ramp([0, 30, 60], [3.0, 2.0, 3.0]),
        SOURCE_B: make_ramp([0, 60], [2.0, 2.0]),
        SOURCE_C: make_ramp([0, 60], [2.0, 2.0]),
    },
    # 三重交点恰在内部非采样时刻（构造：A 1→5，B 5→1，C 恒 3，t=30）
    {
        SOURCE_A: make_ramp([0, 60], [1.0, 5.0]),
        SOURCE_B: make_ramp([0, 60], [5.0, 1.0]),
        SOURCE_C: make_ramp([0, 40, 60], [3.0, 3.0, 3.0]),
    },
    # 非均匀间隔，取到 60 s 上限
    {
        SOURCE_A: make_ramp([0, 60, 90, 150], [5.0, 0.5, 6.0, 1.0]),
        SOURCE_B: make_ramp([0, 40, 100, 150], [0.5, 6.0, 0.5, 6.0]),
        SOURCE_C: make_ramp([0, 50, 110, 150], [3.0, 3.0, 4.0, 2.0]),
    },
    # 恒温长批次（量级与真实放行批次接近）
    {
        SOURCE_A: [(t, 121.1) for t in (0, 60, 120, 180)],
        SOURCE_B: [(t, 121.3) for t in (0, 45, 120, 180)],
        SOURCE_C: [(t, 120.9) for t in (0, 90, 150, 180)],
    },
]


@pytest.mark.parametrize("points_map", ORACLE_CASES)
class TestAgainstOracle:
    def test_median_total_matches_independent_oracle(self, points_map):
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        expected = oracle_median_total(points_map)
        assert result.median_unrounded == pytest.approx(expected, abs=1e-3)

    def test_segment_contributions_sum_to_total(self, points_map):
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        assert sum(s.contribution for s in result.segments) == pytest.approx(
            result.median_unrounded
        )

    def test_median_total_never_exceeds_largest_probe_total(self, points_map):
        # 逐时刻中位速率不超过同一时刻的最大速率 ⇒ 积分上界为最大总量。
        # 注意它可以**低于最小总量**：两支探头在不同时段交替最冷时，
        # 逐刻中位把每段冷区都计入，这正是不能改取“三份总量中位数”的原因。
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        totals = [
            result.probe_a.total_unrounded,
            result.probe_b.total_unrounded,
            result.probe_c.total_unrounded,
        ]
        assert result.median_unrounded <= max(totals) + 1e-9

    def test_reported_probe_rates_match_independent_interpolation(self, points_map):
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        for seg in result.segments:
            assert seg.rate_a_start == pytest.approx(
                _linear_rate(points_map[SOURCE_A], seg.start_time)
            )
            assert seg.rate_a_end == pytest.approx(
                _linear_rate(points_map[SOURCE_A], seg.end_time)
            )
            assert seg.rate_b_start == pytest.approx(
                _linear_rate(points_map[SOURCE_B], seg.start_time)
            )
            assert seg.rate_b_end == pytest.approx(
                _linear_rate(points_map[SOURCE_B], seg.end_time)
            )
            assert seg.rate_c_start == pytest.approx(
                _linear_rate(points_map[SOURCE_C], seg.start_time)
            )
            assert seg.rate_c_end == pytest.approx(
                _linear_rate(points_map[SOURCE_C], seg.end_time)
            )
            # 中位速率等于三探头速率的（容差并列）排序第二
            for boundary, med in (
                ("start", seg.start_rate),
                ("end", seg.end_rate),
            ):
                rates = sorted(
                    (
                        seg.rate_a_start if boundary == "start" else seg.rate_a_end,
                        seg.rate_b_start if boundary == "start" else seg.rate_b_end,
                        seg.rate_c_start if boundary == "start" else seg.rate_c_end,
                    )
                )
                assert med == pytest.approx(rates[1])

    def test_source_is_fixed_order_choice_of_median_tie_group(self, points_map):
        # 每段来源必须是“中点三速率排序第二”所在并列组中固定顺序最前者
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        rate_of = {
            SOURCE_A: lambda s: (s.rate_a_start + s.rate_a_end) / 2,
            SOURCE_B: lambda s: (s.rate_b_start + s.rate_b_end) / 2,
            SOURCE_C: lambda s: (s.rate_c_start + s.rate_c_end) / 2,
        }
        for seg in result.segments:
            values = {p: rate_of[p](seg) for p in PROBE_ORDER}
            ordered = sorted(PROBE_ORDER, key=lambda p: (values[p], PROBE_ORDER.index(p)))
            median_value = (values[ordered[0]] + values[ordered[2]]) / 2
            # 与中位值容差相等的探头构成并列组，source 必须是其中顺序最前者
            tie = [
                p
                for p in PROBE_ORDER
                if math.isclose(values[p], values[ordered[1]], rel_tol=1e-9, abs_tol=1e-9)
                or math.isclose(values[p], median_value, rel_tol=1e-9, abs_tol=1e-9)
            ]
            assert seg.source == tie[0]
            assert list(seg.tie) == tie
            # reason 用中文探头名说明来源，须能对应回裁决出的探头
            from app.lethality_triple import PROBE_LABELS

            assert PROBE_LABELS[seg.source] in seg.reason

    def test_segments_tile_full_horizon_without_gaps(self, points_map):
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        assert result.segments[0].start_time == pytest.approx(0.0)
        assert result.segments[-1].end_time == pytest.approx(
            float(points_map[SOURCE_A][-1][0])
        )
        for prev, nxt in zip(result.segments, result.segments[1:]):
            assert nxt.start_time == pytest.approx(prev.end_time)
            assert nxt.index == prev.index + 1
            assert nxt.duration_seconds > 0

    def test_orders_are_permutations_using_fixed_order_within_ties(self, points_map):
        result = compute_triple_lethality(
            points_map[SOURCE_A], points_map[SOURCE_B], points_map[SOURCE_C]
        )
        for seg in result.segments:
            assert sorted(seg.start_order) == sorted(PROBE_ORDER)
            assert sorted(seg.end_order) == sorted(PROBE_ORDER)


class TestCriticalDecisionUsesUnroundedTotal:
    def _flat_probes(self, rate: float, seconds: int):
        temp = temp_for_rate(rate)
        points = [(0, temp), (seconds, temp)]
        return points, points, points

    def test_unrounded_just_below_threshold_fails_even_though_display_rounds_up(self):
        # rate × 180/60 = 2.99996 → 展示四舍五入为 3.00，未舍入 < 3.00 不放行
        rate = 2.99996 / 3.0
        points_a, points_b, points_c = self._flat_probes(rate, 180)
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert result.median_unrounded == pytest.approx(2.99996)
        assert result.median_f0 == pytest.approx(3.0)
        assert result.passed is False
        assert result.shortfall == pytest.approx(3.0 - 2.99996)

    def test_unrounded_at_or_above_threshold_passes(self):
        rate = 3.00001 / 3.0
        points_a, points_b, points_c = self._flat_probes(rate, 180)
        result = compute_triple_lethality(points_a, points_b, points_c)
        assert result.median_unrounded == pytest.approx(3.00001)
        assert result.passed is True
        assert result.shortfall is None

    def test_exactly_three_minutes_passes(self):
        points = [(0, 121.1), (60, 121.1), (120, 121.1), (180, 121.1)]
        result = compute_triple_lethality(points, points, points)
        assert result.median_unrounded == pytest.approx(3.0)
        assert result.passed is True
        assert result.shortfall is None


class TestLocalAnomalyNotMaskedByTotalsMedian:
    def test_median_of_totals_differs_from_pointwise_median(self):
        # 各探头在不同时段“最冷”，逐刻中位与三份总量的中位数显著不同。
        #
        # 速率分段线性（节点秒 / 速率）：
        #   A: (0,2) (20,1) (40,7) (60,7)
        #   B: (0,2) (30,1) (60,2)
        #   C: (0,7) (20,7) (40,1) (60,1)
        #
        # 手算总量：A=25/6≈4.167，B=1.5，C=4.0 ⇒ 三份总量中位数 4.0；
        # 逐刻中位的内部交点：A=B 在 t=21，A=C 在 t=30，B=C 在 t=39。
        # 并集时刻 0/20/30/40/60 叠加交点后六段，中位来源序列 B,B,A,C,B,B：
        #   [ 0,20] 中位 B（2→4/3）         贡献 (2+4/3)/2×20/60 = 0.55556
        #   [20,21] 中位 B（4/3→1.3）       贡献 0.02194
        #   [21,30] 中位 A（1.3→4）         贡献 0.3975
        #   [30,39] 中位 C（4→1.3）         贡献 0.3975
        #   [39,40] 中位 B（1.3→4/3）       贡献 0.02194
        #   [40,60] 中位 B（4/3→2）         贡献 0.55556
        # 合计 1.95，严格小于总量中位数 4.0：局部异常若按总量取中位会被掩盖。
        points_a = make_ramp([0, 20, 40, 60], [2.0, 1.0, 7.0, 7.0])
        points_b = make_ramp([0, 30, 60], [2.0, 1.0, 2.0])
        points_c = make_ramp([0, 20, 40, 60], [7.0, 7.0, 1.0, 1.0])
        result = compute_triple_lethality(points_a, points_b, points_c)

        totals_median = sorted(
            (
                result.probe_a.total_unrounded,
                result.probe_b.total_unrounded,
                result.probe_c.total_unrounded,
            )
        )[1]
        assert result.probe_a.total_unrounded == pytest.approx(25.0 / 6.0)
        assert result.probe_b.total_unrounded == pytest.approx(1.5)
        assert result.probe_c.total_unrounded == pytest.approx(4.0)
        assert totals_median == pytest.approx(4.0)
        assert result.median_unrounded == pytest.approx(1.95)
        # 内部交点切分：并集 0/20/30/40/60 加 21、39（t=30 本就是并集时刻）
        boundaries = [result.segments[0].start_time]
        boundaries.extend(s.end_time for s in result.segments)
        assert boundaries == pytest.approx(
            [0.0, 20.0, 21.0, 30.0, 39.0, 40.0, 60.0], abs=1e-7
        )
        # 来源序列经历 B→A→C→B 的多次换源（各探头在不同时段承担中位）
        assert [s.source for s in result.segments] == [
            SOURCE_B,
            SOURCE_B,
            SOURCE_A,
            SOURCE_C,
            SOURCE_B,
            SOURCE_B,
        ]


class TestInvalidInput:
    def test_mismatched_end_seconds_rejected(self):
        with pytest.raises(ValueError):
            compute_triple_lethality(
                [(0, 121.1), (60, 121.1)],
                [(0, 121.1), (60, 121.1)],
                [(0, 121.1), (59, 121.1)],
            )

    def test_not_starting_at_zero_rejected(self):
        with pytest.raises(ValueError):
            compute_triple_lethality(
                [(1, 121.1), (60, 121.1)],
                [(0, 121.1), (60, 121.1)],
                [(0, 121.1), (60, 121.1)],
            )

    def test_too_few_points_rejected(self):
        with pytest.raises(ValueError):
            compute_triple_lethality(
                [(0, 121.1)],
                [(0, 121.1), (60, 121.1)],
                [(0, 121.1), (60, 121.1)],
            )
