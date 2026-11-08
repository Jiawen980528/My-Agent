"""Regression tests for the authenticated MyAgent context bridge."""

from types import SimpleNamespace

from app.api import bridge


def test_shared_context_reports_actual_kline_sources(monkeypatch):
    monkeypatch.setenv("TICKFLOW_BRIDGE_TOKEN", "test-token")
    request = SimpleNamespace(headers={"x-tickflow-bridge-token": "test-token"})
    monkeypatch.setattr(bridge, "market_overview", lambda _request: {"as_of": "2026-11-08T10:00:00+08:00"})

    def fake_daily(_request, *, symbol, days):
        source = "custom-provider" if symbol == "600519.SH" else "enriched"
        return {"symbol": symbol, "days": days, "source": source, "rows": []}

    monkeypatch.setattr(bridge, "get_daily", fake_daily)

    result = bridge.shared_context(request, symbols="600519.SH,159558.SZ,600519.SH", days=20)

    assert result["source"] == "mixed"
    assert result["kline_sources"] == {"600519.SH": "custom-provider", "159558.SZ": "enriched"}
    assert [row["symbol"] for row in result["klines"]] == ["600519.SH", "159558.SZ"]
    assert result["read_only"] is True
    assert result["account"]["verified"] is False
    assert result["capabilities"]["orders"] is False


def test_shared_context_includes_real_quote_provenance(monkeypatch):
    monkeypatch.setenv("TICKFLOW_BRIDGE_TOKEN", "test-token")
    request = SimpleNamespace(
        headers={"x-tickflow-bridge-token": "test-token"},
        app=SimpleNamespace(state=SimpleNamespace(repo=SimpleNamespace(
            resolve_asset_type=lambda _symbol: "etf",
        ))),
    )
    monkeypatch.setattr(bridge, "market_overview", lambda _request: {"as_of": "2026-11-08T10:00:00+08:00"})
    monkeypatch.setattr(bridge, "get_daily", lambda _request, *, symbol, days: {
        "symbol": symbol, "source": "TickFlow", "rows": [], "days": days,
    })
    monkeypatch.setattr(bridge, "quote_snapshot", lambda symbols, *, asset_types: {
        "status": "ok", "source": "TickFlow", "items": [
            {"symbol": symbols[0], "price": 1.23, "timestamp": "2026-11-08T10:00:00+08:00"},
        ],
    })

    result = bridge.shared_context(request, symbols="159558.SZ", days=20)

    assert result["quotes"]["source"] == "TickFlow"
    assert result["capabilities"]["quotes"] is True
    assert result["capabilities"]["account"] is False
