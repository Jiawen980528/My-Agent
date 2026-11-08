"""Ensure forecast responses preserve the configured minute source."""

import asyncio
from datetime import date
from types import SimpleNamespace

import polars as pl

from app.api import myagent_bridge
from app.tickflow.capabilities import Cap, CapabilityLimits, CapabilitySet


def _request(repo):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        repo=repo, capabilities=CapabilitySet({Cap.KLINE_MINUTE_BY_SYMBOL: CapabilityLimits()}),
    )))


def test_symbol_forecast_reports_selected_minute_source(monkeypatch):
    repo = SimpleNamespace(resolve_asset_type=lambda _symbol: "stock")
    frame = pl.DataFrame({
        "symbol": ["600519.SH", "600519.SH"],
        "datetime": ["2026-11-08 09:31", "2026-11-08 09:32"],
        "amount": [100.0, 120.0],
    })
    monkeypatch.setattr(myagent_bridge, "fetch_minute_single", lambda *args, **kwargs: frame)
    monkeypatch.setattr(myagent_bridge, "forecast_amount", lambda *_args: {"status": "ok"})
    monkeypatch.setattr(myagent_bridge, "selected_minute_source", lambda: "CustomMinute")

    result = asyncio.run(myagent_bridge.volume_forecast_for_symbol(
        _request(repo), symbol="600519.SH", trade_date=date(2026, 11, 8),
    ))

    assert result["source"] == "CustomMinute分钟成交额"


def test_market_forecast_reports_selected_minute_source(monkeypatch):
    repo = SimpleNamespace(
        get_instruments_asset=lambda _asset: pl.DataFrame({"symbol": ["600519.SH"]}),
        get_minute_batch=lambda *_args, **_kwargs: pl.DataFrame(),
    )
    monkeypatch.setattr(myagent_bridge, "forecast_market_amount", lambda *_args: {"status": "unavailable"})
    monkeypatch.setattr(myagent_bridge, "selected_minute_source", lambda: "CustomMinute")

    result = asyncio.run(myagent_bridge.market_volume_forecast(
        _request(repo), trade_date=date(2026, 11, 8),
    ))

    assert result["source"] == "CustomMinute全市场分钟分区"
