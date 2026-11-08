"""Internal bridge API for sharing TickFlow data with MyAgent.

This route is server-to-server only. The bridge token is never sent to the
browser and the response is deliberately scoped to the requested symbols.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Query, Request

from app.api.overview import market_overview
from app.api.kline import get_daily
from app.services.kline_sync import selected_minute_source, sync_minute_batch
from app.services.portfolio_account import unavailable
from app.tickflow.capabilities import Cap
from app.services.market_data_service import batch_completeness, freshness, minute_bars, minute_quality, quote_snapshot
from app.services.volume_forecast import forecast_amount

router = APIRouter(prefix="/api/bridge", tags=["bridge"])
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
_CN = ZoneInfo("Asia/Shanghai")


def _qualified_symbol(value: str) -> str:
    """Normalize a six-digit MyAgent code for the TickFlow repository."""
    symbol = str(value or "").strip().upper().replace(".SS", ".SH")
    if "." not in symbol and len(symbol) == 6 and symbol.isdigit():
        suffix = ".SH" if symbol.startswith(("5", "6", "688")) else ".BJ" if symbol.startswith(("4", "8")) else ".SZ"
        return symbol + suffix
    return symbol


def _check_token(request: Request) -> None:
    expected = (os.getenv("TICKFLOW_BRIDGE_TOKEN") or "").strip()
    supplied = (request.headers.get("x-tickflow-bridge-token") or "").strip()
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="bridge unauthorized")


@router.get("/account-status")
def account_status(request: Request):
    """Expose the read-only account-provider contract without inventing data."""
    _check_token(request)
    provider = str(os.getenv("PORTFOLIO_ACCOUNT_PROVIDER") or "").strip().lower()
    if provider not in {"qmt", "ptrade", "broker_realtime"}:
        return unavailable("未配置券商只读账户适配器")
    # A provider name alone is not proof that a Windows broker adapter is alive.
    return unavailable("券商账户适配器尚未建立已核验连接", source=provider)


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
        return forecast_amount(current, history, source=f"{selected_minute_source()}分钟成交额")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/context")
def shared_context(
    request: Request,
    symbols: str = Query("", max_length=400),
    days: int = Query(60, ge=20, le=200),
):
    """Return a read-only, provenance-aware market context for MyAgent AI.

    This endpoint is intentionally fail-closed: account values, quotes and
    other optional feeds are included only when their real adapter returns
    them.  Missing adapters are represented as ``unavailable`` rather than
    being inferred from prices or browser state.
    """
    _check_token(request)
    requested = []
    for raw in symbols.split(","):
        value = raw.strip().upper()
        if value and value not in requested:
            requested.append(value)
    requested = requested[:12]
    overview = market_overview(request)
    klines = []
    kline_sources: dict[str, str] = {}
    for symbol in requested:
        try:
            # MyAgent uses bare six-digit codes; TickFlow's repository uses
            # exchange-qualified symbols.
            qualified = _qualified_symbol(symbol)
            result = get_daily(request, symbol=qualified, days=days)
            klines.append(result)
            kline_sources[qualified] = str(result.get("source") or "unlabeled")
        except Exception:
            # One unavailable symbol must not prevent the rest of the context.
            continue
    sources = sorted(set(kline_sources.values()))
    # Keep the AI bridge useful for the current screen as well as historical
    # analysis.  A quote failure must not make valid daily context disappear.
    quotes: dict = {"status": "unavailable", "source": "unavailable", "items": []}
    try:
        qualified_symbols = list(kline_sources) or [
            _qualified_symbol(value) for value in requested
            if _SYMBOL.fullmatch(_qualified_symbol(value))
        ]
        if qualified_symbols:
            asset_types = {
                symbol: request.app.state.repo.resolve_asset_type(symbol)
                for symbol in qualified_symbols
            }
            quotes = quote_snapshot(qualified_symbols, asset_types=asset_types)
    except Exception:
        # The bridge must still return market/daily context when the realtime
        # provider is down or the host is running without a repository.
        quotes = {"status": "unavailable", "source": "unavailable", "items": []}

    try:
        account = account_status(request)
    except Exception:
        account = unavailable("账户只读适配器不可用")

    capabilities = {
        "quotes": quotes.get("status") == "ok" or bool(quotes.get("items")),
        "daily_kline": bool(klines),
        "account": bool(account.get("verified") is True),
        "minute_kline": "通过 /portfolio-minute 或 /portfolio-minute-batch 按权限调用",
        "fund_flow": "通过 MyAgent fund-flow 接口按数据源调用；未接入时不可用",
        "orders": False,
    }
    return {
        "source": sources[0] if len(sources) == 1 else "mixed" if sources else "unavailable",
        "kline_sources": kline_sources,
        "as_of": overview.get("as_of"),
        "market": overview,
        "symbols": requested,
        "klines": klines,
        "quotes": quotes,
        "account": account,
        "capabilities": capabilities,
        "read_only": True,
    }


@router.get("/portfolio-quotes")
def portfolio_quotes(request: Request, symbols: str = Query(..., max_length=1000)):
    """Small, authenticated market snapshot for MyAgent; no account information."""
    _check_token(request)
    requested = list(dict.fromkeys(part.strip().upper().replace(".SS", ".SH") for part in symbols.split(",")))
    if not requested or len(requested) > 100 or any(not _SYMBOL.fullmatch(s) for s in requested):
        raise HTTPException(status_code=400, detail="invalid symbols")
    try:
        asset_types = {symbol: request.app.state.repo.resolve_asset_type(symbol) for symbol in requested}
        snapshot = quote_snapshot(requested, asset_types=asset_types)
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
async def portfolio_minute_batch(request: Request, symbols: str = Query(..., max_length=1000),
                                 trade_date: date | None = None):
    """Fetch minute bars in batch, or bounded single-symbol fallback when licensed."""
    _check_token(request)
    requested = list(dict.fromkeys(part.strip().upper().replace(".SS", ".SH") for part in symbols.split(",")))
    capset = request.app.state.capabilities
    batch_available = capset.has(Cap.KLINE_MINUTE_BATCH)
    single_available = capset.has(Cap.KLINE_MINUTE_BY_SYMBOL)
    if batch_available:
        limit = min(100, int(capset.limits(Cap.KLINE_MINUTE_BATCH).batch or 100))
    elif single_available:
        single_limit = int(capset.limits(Cap.KLINE_MINUTE_BY_SYMBOL).rpm or 30)
        limit = min(30, max(1, single_limit))
    else:
        raise HTTPException(status_code=503, detail="分钟行情权限不可用")
    if not requested or len(requested) > limit or any(not _SYMBOL.fullmatch(s) for s in requested):
        raise HTTPException(status_code=400, detail="invalid symbols or minute batch entitlement")
    day = trade_date or datetime.now(_CN).date()
    if day > datetime.now(_CN).date():
        raise HTTPException(status_code=400, detail="future date")
    grouped = {symbol: [] for symbol in requested}
    errors: dict[str, str] = {}
    selected_source = selected_minute_source()
    if batch_available:
        start = datetime(day.year, day.month, day.day, 9, 25, tzinfo=_CN)
        end = datetime(day.year, day.month, day.day, 15, 5, tzinfo=_CN)
        try:
            frame = await asyncio.to_thread(sync_minute_batch, requested, start_time=start, end_time=end, batch_size=limit)
        except PermissionError as exc:
            raise HTTPException(status_code=503, detail="分钟行情权限不可用") from exc
        except (OSError, TimeoutError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=502, detail=f"TickFlow 分钟行情暂不可用：{type(exc).__name__}") from exc
        for row in frame.to_dicts():
            symbol = row.get("symbol")
            if symbol in grouped:
                grouped[symbol].append({**row, "datetime": str(row["datetime"]), "source": selected_source})
        source = "TickFlow Pro" if selected_source == "TickFlow" else selected_source
        request_count = 1
    else:
        async def fetch_one(symbol: str):
            try:
                asset_type = request.app.state.repo.resolve_asset_type(symbol)
                result = await asyncio.to_thread(minute_bars, symbol, day, capset=capset, asset_type=asset_type)
                return symbol, result["rows"], None
            except (OSError, PermissionError, ValueError, TypeError) as exc:
                return symbol, [], type(exc).__name__

        results = await asyncio.gather(*(fetch_one(symbol) for symbol in requested))
        for symbol, rows, error in results:
            grouped[symbol] = rows
            if error:
                errors[symbol] = error
        source = ("TickFlow（单标分钟权限回退）" if selected_source == "TickFlow"
                  else f"{selected_source}（单标分钟权限回退）")
        request_count = len(requested)
    received_at = datetime.now(_CN)
    status = {}
    quality = {}
    for symbol, rows in grouped.items():
        latest = rows[-1].get("datetime") if rows else None
        status[symbol] = freshness(latest, received_at=received_at)
        quality[symbol] = minute_quality(rows)
    completeness = batch_completeness(grouped, errors)
    return {"trade_date": day.isoformat(), "source": source, "data": grouped,
            "freshness": status, "quality": quality, "errors": errors,
            "request_count": request_count, "symbol_count": len(requested), **completeness}
