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
from app.services.kline_sync import fetch_minute_single, sync_minute_batch
from app.services import ptrade_replay
from app.tickflow.client import get_client
from app.tickflow.capabilities import Cap

router = APIRouter(prefix="/api/bridge", tags=["bridge"])
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
_CN = ZoneInfo("Asia/Shanghai")


def _check_token(request: Request) -> None:
    expected = (os.getenv("TICKFLOW_BRIDGE_TOKEN") or "").strip()
    supplied = (request.headers.get("x-tickflow-bridge-token") or "").strip()
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="bridge unauthorized")


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
        rows = get_client().quotes.get(symbols=requested)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="TickFlow quotes unavailable") from exc
    return {"source": "TickFlow Pro", "items": [{
        "symbol": row.get("symbol"), "name": (row.get("ext") or {}).get("name"),
        "price": row.get("last_price"), "prev_close": row.get("prev_close"),
        "high": row.get("high"), "low": row.get("low"),
        "amount": row.get("amount"), "volume": row.get("volume"),
        "timestamp": row.get("timestamp"),
    } for row in (rows or [])]}


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
    bars = fetch_minute_single(symbol, day, asset_type=kind, capset=capset)
    items = [{**row, "datetime": str(row["datetime"])} for row in bars.to_dicts()]
    replay = None
    replay_symbol = symbol.replace(".SH", ".SS") if symbol == "588080.SH" else symbol
    if replay_symbol in ptrade_replay.SYMBOLS and day.isoformat() == ptrade_replay.TARGET_DAY:
        replay_rows = [{**row, "symbol": replay_symbol,
                        "datetime": row["datetime"].replace(" ", "T") + "+08:00",
                        "volume": row["volume"] * 100, "source": "tickflow_pro"}
                       for row in items if row["datetime"][11:16] != "09:30"]
        replay = ptrade_replay.replay(replay_symbol, replay_rows, source="TickFlow Pro（成交点为用户提供）")
        replay.pop("rows", None)
    return {"symbol": symbol, "trade_date": day.isoformat(), "asset_type": kind,
            "source": "TickFlow Pro", "rows": items,
            "last_market_time": items[-1]["datetime"] if items else None,
            "replay": replay}


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
    return {"trade_date": day.isoformat(), "source": "TickFlow Pro", "data": grouped,
            "request_count": 1, "symbol_count": len(requested)}
