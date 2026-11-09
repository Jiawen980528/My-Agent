"""Regression tests for the authenticated MyAgent context bridge."""

from types import SimpleNamespace

from app.api import bridge
from fastapi import HTTPException


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


def test_shared_context_qualifies_bare_code_for_quote_fallback(monkeypatch):
    monkeypatch.setenv("TICKFLOW_BRIDGE_TOKEN", "test-token")
    request = SimpleNamespace(
        headers={"x-tickflow-bridge-token": "test-token"},
        app=SimpleNamespace(state=SimpleNamespace(repo=SimpleNamespace(
            resolve_asset_type=lambda _symbol: "etf",
        ))),
    )
    monkeypatch.setattr(bridge, "market_overview", lambda _request: {"as_of": None})
    monkeypatch.setattr(bridge, "get_daily", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("no daily")))
    captured: list[str] = []

    def fake_quotes(symbols, *, asset_types):
        captured.extend(symbols)
        return {"source": "TickFlow", "items": [{"symbol": symbols[0], "price": 1.0}]}

    monkeypatch.setattr(bridge, "quote_snapshot", fake_quotes)

    result = bridge.shared_context(request, symbols="159558", days=20)

    assert captured == ["159558.SZ"]
    assert result["capabilities"]["quotes"] is True


def test_ptrade_snapshot_is_read_only_and_normalized():
    result = bridge._validate_ptrade_snapshot({
        "source": "ptrade",
        "read_only": True,
        "positions": [
            {"symbol": "588080.SS", "name": "科创50ETF", "quantity": 1000, "last": 1.2},
            {"symbol": "not-a-symbol", "quantity": 9999},
        ],
        "quotes": [{"symbol": "588080.SS", "last": 1.2}],
        "blocks": [{"code": "BK0001", "name": "半导体"}],
    })
    assert result["read_only"] is True
    assert result["positions"] == [{
        "symbol": "588080.SH", "name": "科创50ETF", "quantity": 1000,
        "available_quantity": None, "cost": None, "last": 1.2,
        "change_pct": None, "market_value": None,
    }]
    assert result["trades"] == []


def test_ptrade_snapshot_rejects_non_read_only():
    try:
        bridge._validate_ptrade_snapshot({"source": "ptrade", "read_only": False})
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("non-read-only payload must be rejected")
