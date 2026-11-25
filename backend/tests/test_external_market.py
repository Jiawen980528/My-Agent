from app.api.external_market import _parse_quote
from app.services.market_overview_builder import _arms_index


def test_parse_quote_keeps_timestamp_and_change():
    payload = {
        "chart": {
            "result": [{
                "meta": {"regularMarketPrice": 101, "previousClose": 100},
                "timestamp": [1, 2],
                "indicators": {"quote": [{"close": [100, 101]}]},
            }],
        },
    }
    row = _parse_quote("^TEST", "测试指数", payload)
    assert row["status"] == "ok"
    assert row["last"] == 101.0
    assert row["change_pct"] == 1.0
    assert row["as_of"] == "1970-01-01T00:00:02+00:00"


def test_parse_quote_reports_unavailable_without_filling_zero():
    row = _parse_quote("^MISSING", "缺失指数", {"chart": {"result": [{}]}})
    assert row["status"] == "unavailable"
    assert row["last"] is None
    assert row["change_pct"] is None


def test_arms_index_uses_real_volume_and_is_not_zero_filled():
    rows = [
        {"change_pct": 1, "volume": 100},
        {"change_pct": 2, "volume": 100},
        {"change_pct": -1, "volume": 50},
        {"change_pct": -2, "volume": 50},
    ]
    result = _arms_index(rows)
    assert result["status"] == "ok"
    assert result["value"] == 0.5
    assert _arms_index([{ "change_pct": 1, "volume": 10 }])["value"] is None
