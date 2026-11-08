"""Internal bridge API for sharing TickFlow data with MyAgent.

This route is server-to-server only. The bridge token is never sent to the
browser and the response is deliberately scoped to the requested symbols.
"""
from __future__ import annotations

import hmac
import os
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Query, Request

from app.api.overview import market_overview
from app.api.kline import get_daily
from app.services.kline_sync import sync_minute_batch
from app.tickflow.capabilities import Cap
from app.services.market_data_service import freshness, minute_bars, quote_snapshot
from app.services.volume_forecast import forecast_amount

router = APIRouter(prefix="/api/bridge", tags=["bridge"])
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
_CN = ZoneInfo("Asia/Shanghai")


def _check_token(request: Request) -> None:
    expected = (os.getenv("TICKFLOW_BRIDGE_TOKEN") or "").strip()
    supplied = (request.headers.get("x-tickflow-bridge-token") or "").strip()
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="bridge unauthorized")


@router.post("/volume-forecast")
async def volume_forecast(request: Request):
    """Forecast full-day turnover from real minute amount profiles only."""
    _check_token(request)
    try:
        payload = await request.json()
        current = payload.get("current_rows", [])
        history = payload.get("historical_days", [])
        if not isinstance(current, list) or not isinstance(history, list):
            raise ValueError("current_rows 和 historical_days 必须为数组")
        return forecast_amount(current, history)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/context")
def shared_context(
    request: Request,
    symbols: str = Query("", max_length=400),
    days: int = Query(60, ge=20, le=200),
):
    """Return a compact market + selected-stock context for MyAgent AI."""
    _check_token(request)
    requested = []
    for raw in symbols.split(","):
        value = raw.strip().upper()
        if value and value not in requested:
            requested.append(value)
    requested = requested[:12]
    overview = market_overview(request)
    klines = []
    for symbol in requested:
        try:
            # MyAgent uses bare six-digit codes; TickFlow's repository uses
            # exchange-qualified symbols.
            qualified = symbol
            if "." not in qualified and len(qualified) == 6 and qualified.isdigit():
                suffix = ".SH" if qualified.startswith(("5", "6", "688")) else ".BJ" if qualified.startswith(("4", "8")) else ".SZ"
                qualified = qualified + suffix
            klines.append(get_daily(request, symbol=qualified, days=days))
        except Exception:
            # One unavailable symbol must not prevent the rest of the context.
            continue
    return {
        "source": "tickflow",
        "as_of": overview.get("as_of"),
        "market": overview,
        "symbols": requested,
        "klines": klines,
    }


@router.get("/portfolio-quotes")
def portfolio_quotes(request: Request, symbols: str = Query(..., max_length=1000)):
    """Small, authenticated market snapshot for MyAgent; no account information."""
    _check_token(request)
    requested = list(dict.fromkeys(part.strip().upper().replace(".SS", ".SH") for part in symbols.split(",")))
    if not requested or len(requested) > 100 or any(not _SYMBOL.fullmatch(s) for s in requested):
        raise HTTPException(status_code=400, detail="invalid symbols")
    try:
        snapshot = quote_snapshot(requested)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="TickFlow quotes unavailable") from exc
    return snapshot


@router.get("/portfolio-minute")
def portfolio_minute(request: Request, symbol: str, trade_date: date | None = None):
    """Read actual licensed minute bars for one stock, ETF or exchange index."""
    _check_token(request)
    symbol = symbol.strip().upper().replace(".SS", ".SH")
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(status_code=400, detail="invalid symbol")
    day = trade_date or datetime.now(_CN).date()
    if day > datetime.now(_CN).date():
        raise HTTPException(status_code=400, detail="future date")
    capset = request.app.state.capabilities
    if not capset.has(Cap.KLINE_MINUTE_BY_SYMBOL):
        raise HTTPException(status_code=503, detail="minute entitlement unavailable")
    repo = request.app.state.repo
    kind = repo.resolve_asset_type(symbol)
    snapshot = minute_bars(symbol, day, capset=capset, asset_type=kind)
    items = snapshot["rows"]
    return {"symbol": symbol, "trade_date": day.isoformat(), "asset_type": kind,
            "source": snapshot["source"], "rows": items,
            "quality": snapshot["quality"],
            "last_market_time": snapshot["last_market_time"],
            "market_time": snapshot["market_time"], "received_at": snapshot["received_at"],
            "age_seconds": snapshot["age_seconds"], "stale": snapshot["stale"]}


@router.get("/portfolio-minute-batch")
def portfolio_minute_batch(request: Request, symbols: str = Query(..., max_length=1000),
                           trade_date: date | None = None):
    """Fetch up to the subscribed 100 securities in one licensed minute request."""
    _check_token(request)
    requested = list(dict.fromkeys(part.strip().upper().replace(".SS", ".SH") for part in symbols.split(",")))
    capset = request.app.state.capabilities
    limit = min(100, int(capset.limits(Cap.KLINE_MINUTE_BATCH).batch or 100)) if capset.has(Cap.KLINE_MINUTE_BATCH) else 0
    if not requested or len(requested) > limit or any(not _SYMBOL.fullmatch(s) for s in requested):
        raise HTTPException(status_code=400, detail="invalid symbols or minute batch entitlement")
    day = trade_date or datetime.now(_CN).date()
    if day > datetime.now(_CN).date():
        raise HTTPException(status_code=400, detail="future date")
    start = datetime(day.year, day.month, day.day, 9, 25, tzinfo=_CN)
    end = datetime(day.year, day.month, day.day, 15, 5, tzinfo=_CN)
    frame = sync_minute_batch(requested, start_time=start, end_time=end, batch_size=limit)
    grouped = {symbol: [] for symbol in requested}
    for row in frame.to_dicts():
        symbol = row.get("symbol")
        if symbol in grouped:
            grouped[symbol].append({**row, "datetime": str(row["datetime"])})
    received_at = datetime.now(_CN)
    status = {}
    for symbol, rows in grouped.items():
        latest = rows[-1].get("datetime") if rows else None
        status[symbol] = freshness(latest, received_at=received_at)
    return {"trade_date": day.isoformat(), "source": "TickFlow Pro", "data": grouped,
            "freshness": status, "request_count": 1, "symbol_count": len(requested)}
