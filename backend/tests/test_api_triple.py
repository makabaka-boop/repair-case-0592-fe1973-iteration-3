"""三探头中位复核接口测试：中位结果、按探头定位的 422、旧接口兼容。"""

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def temp(rate: float) -> float:
    return 121.1 + 10 * math.log10(rate)


def p(time, temperature) -> dict:
    return {"time": time, "temperature": temperature}


def triple_payload(points_a, points_b, points_c) -> dict:
    return {
        "probeA": {"points": points_a},
        "probeB": {"points": points_b},
        "probeC": {"points": points_c},
    }


def post_triple(payload: dict):
    return client.post("/api/lethality/triple", json=payload)


def post_triple_raw(raw: str):
    return client.post(
        "/api/lethality/triple",
        content=raw,
        headers={"Content-Type": "application/json"},
    )


def errors_of(response) -> list[dict]:
    assert response.status_code == 422, response.text
    return response.json()["detail"]["errors"]


def has_error(errors, row, field, probe=None) -> bool:
    return any(
        e["row"] == row and e["field"] == field and e.get("probe") == probe
        for e in errors
    )


CONST_121 = [p(t, 121.1) for t in (0, 60, 120, 180)]


class TestTripleHappyPath:
    def test_identical_probes_median_equals_single_result(self):
        body = post_triple(triple_payload(CONST_121, CONST_121, CONST_121)).json()
        assert body["passed"] is True
        assert body["threshold"] == pytest.approx(3.0)
        assert body["medianUnrounded"] == pytest.approx(3.0)
        assert body["medianF0"] == pytest.approx(3.0)
        assert body["probeCTotalUnrounded"] == pytest.approx(3.0)
        assert body["shortfall"] is None
        # 三线完全重合：每段并列三探头，固定顺序裁决取 probeA
        assert len(body["segments"]) == 3
        assert all(s["source"] == "probeA" for s in body["segments"])
        assert all(s["tie"] == ["probeA", "probeB", "probeC"] for s in body["segments"])
        assert all("固定顺序" in s["reason"] for s in body["segments"])
        # 每段都回传三支探头各自的速率，供表格与图形共用同一响应
        seg = body["segments"][0]
        assert seg["probeCStartRate"] == pytest.approx(1.0)
        assert seg["probeCEndRate"] == pytest.approx(1.0)

    def test_internal_crossings_segmentation_and_source_arbitration(self):
        # A 恒 2；B 1→4；C 4→1：交点 t=20/30/40，来源 A,B,C,A
        payload = triple_payload(
            [p(0, temp(2.0)), p(60, temp(2.0))],
            [p(0, temp(1.0)), p(60, temp(4.0))],
            [p(0, temp(4.0)), p(60, temp(1.0))],
        )
        body = post_triple(payload).json()
        sources = [s["source"] for s in body["segments"]]
        assert sources == ["probeA", "probeB", "probeC", "probeA"]
        boundaries = [body["segments"][0]["startTime"]]
        boundaries.extend(s["endTime"] for s in body["segments"])
        assert boundaries == pytest.approx([0.0, 20.0, 30.0, 40.0, 60.0])
        assert body["medianUnrounded"] == pytest.approx(25.0 / 12.0)
        assert sum(s["contribution"] for s in body["segments"]) == pytest.approx(
            body["medianUnrounded"]
        )
        # 摘要、片段、图表共用同一组边界：probeC 曲线点随响应回传
        assert body["probeC"]["points"][0]["rate"] == pytest.approx(4.0)
        # 每段 reason 说明为何由该探头贡献，并给出完整排序
        first = body["segments"][0]
        assert first["reason"].startswith("中段速率由低到高")
        # t=0 速率 B=1<A=2<C=4；t=20 处 A=B 并列，按固定顺序排为 A,B,C
        assert first["startOrder"] == ["probeB", "probeA", "probeC"]
        assert first["endOrder"] == ["probeA", "probeB", "probeC"]

    def test_failing_batch_reports_unrounded_shortfall(self):
        points = [p(t, 121.1) for t in (0, 60, 120, 179)]
        body = post_triple(triple_payload(points, points, points)).json()
        assert body["passed"] is False
        assert body["medianUnrounded"] == pytest.approx(179 / 60)
        assert body["shortfall"] == pytest.approx(3.0 - 179 / 60)

    def test_segment_durations_all_positive_and_tile_horizon(self):
        payload = triple_payload(
            [p(0, temp(1.0)), p(20, temp(5.0)), p(50, temp(1.0)), p(60, temp(5.0))],
            [p(0, temp(5.0)), p(30, temp(1.0)), p(60, temp(5.0))],
            [p(0, temp(3.0)), p(60, temp(3.0))],
        )
        body = post_triple(payload).json()
        segments = body["segments"]
        assert all(s["durationSeconds"] > 0 for s in segments)
        assert segments[0]["startTime"] == pytest.approx(0.0)
        assert segments[-1]["endTime"] == pytest.approx(60.0)
        for prev, nxt in zip(segments, segments[1:]):
            assert nxt["startTime"] == pytest.approx(prev["endTime"])


class TestTripleValidation:
    def test_missing_probe_c_rejected_without_result(self):
        # 第三路缺样：只拒绝本次分析，响应不含任何结果字段
        response = client.post(
            "/api/lethality/triple",
            json={
                "probeA": {"points": CONST_121},
                "probeB": {"points": CONST_121},
            },
        )
        assert response.status_code == 422
        body = response.json()
        assert "medianUnrounded" not in body
        assert "segments" not in body
        errors = body["detail"]["errors"]
        assert has_error(errors, None, "probeC", "probeC")

    def test_probe_c_row_error_located_by_probe_and_row(self):
        bad_c = [p(0, 121.1), p(61, 121.1)]
        errors = errors_of(post_triple(triple_payload(CONST_121, CONST_121, bad_c)))
        assert has_error(errors, 2, "time", "probeC")
        assert not any(e.get("probe") in ("probeA", "probeB") for e in errors)

    def test_each_probe_validated_independently(self):
        payload = triple_payload(
            [p(0, 99.0), p(60, 121.1)],
            [p(0, 121.1), p(61, 121.1)],
            CONST_121,
        )
        errors = errors_of(post_triple(payload))
        assert has_error(errors, 1, "temperature", "probeA")
        assert has_error(errors, 2, "time", "probeB")
        assert not any(e.get("probe") == "probeC" for e in errors)

    def test_probe_must_be_object(self):
        response = post_triple(
            {
                "probeA": {"points": CONST_121},
                "probeB": "x",
                "probeC": {"points": CONST_121},
            }
        )
        errors = errors_of(response)
        assert has_error(errors, None, "probeB", "probeB")

    def test_whole_body_must_be_object(self):
        errors = errors_of(post_triple_raw("[1, 2]"))
        assert has_error(errors, None, "body")

    def test_invalid_json_rejected(self):
        errors = errors_of(post_triple_raw("{bad"))
        assert has_error(errors, None, "body")

    def test_end_seconds_must_match_across_three(self):
        payload = triple_payload(
            CONST_121,
            CONST_121,
            [p(0, 121.1), p(60, 121.1)],
        )
        errors = errors_of(post_triple(payload))
        mismatch = [e for e in errors if e["field"] == "probe" and e["row"] is None]
        assert mismatch
        assert "三支探头必须结束于同一秒" in mismatch[0]["message"]
        assert "180" in mismatch[0]["message"] and "60" in mismatch[0]["message"]

    def test_single_point_probe_c_rejected(self):
        errors = errors_of(
            post_triple(triple_payload(CONST_121, CONST_121, [p(0, 121.1)]))
        )
        assert has_error(errors, None, "points", "probeC")

    def test_illegal_nan_temperature_rejected(self):
        response = post_triple_raw(
            '{"probeA": {"points": [{"time": 0, "temperature": 121.1}]},'
            ' "probeB": {"points": [{"time": 0, "temperature": 121.1},'
            '                             {"time": 60, "temperature": 121.1}]},'
            ' "probeC": {"points": [{"time": 0, "temperature": NaN},'
            '                             {"time": 60, "temperature": 121.1}]}}'
        )
        errors = errors_of(response)
        assert has_error(errors, 1, "temperature", "probeC")


class TestOlderEndpointsUnchanged:
    """单/双探头接口的请求与响应语义不因三探头而改变。"""

    def test_single_endpoint_response_shape_unchanged(self):
        response = client.post("/api/lethality", json={"points": CONST_121})
        assert response.status_code == 200
        assert set(response.json().keys()) == {
            "f0",
            "threshold",
            "passed",
            "shortfall",
            "segments",
        }

    def test_dual_endpoint_response_shape_unchanged(self):
        response = client.post(
            "/api/lethality/dual",
            json={
                "probeA": {"points": CONST_121},
                "probeB": {"points": CONST_121},
            },
        )
        body = response.json()
        assert "probeC" not in body
        assert "medianUnrounded" not in body
        assert all(
            "probeCStartRate" not in segment for segment in body["segments"]
        )
        assert body["conservativeUnrounded"] == pytest.approx(3.0)

    def test_dual_endpoint_ignores_extra_probe_c_field(self):
        # 旧双探头接口收到多余 probeC 时语义不变（不升级为三探头分析）
        response = client.post(
            "/api/lethality/dual",
            json={
                "probeA": {"points": CONST_121},
                "probeB": {"points": CONST_121},
                "probeC": {"points": CONST_121},
            },
        )
        assert response.status_code == 200
        assert "probeC" not in response.json()
