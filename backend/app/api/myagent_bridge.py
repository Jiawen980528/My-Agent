"""受 TickFlow 登录保护的 MyAgent 量化模型桥接。"""
from __future__ import annotations

import os
import asyncio
import logging
import re
import sqlite3
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import httpx
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from app.config import settings
from app.services import fund_flow_archive
from app.services import ptrade_replay
from app.services import research_pool
from app.services.decision_engine import build_decision
from app.services.kline_sync import fetch_minute_single, selected_minute_source
from app.services.volume_forecast import forecast_amount
from app.services.market_volume_forecast import forecast_market_amount
from app.tickflow.capabilities import Cap

router = APIRouter(prefix="/api/myagent", tags=["myagent-bridge"])


@router.get("/research-pool")
def get_research_pool(request: Request):
    return research_pool.load(request.app.state.repo.store.data_dir)


@router.post("/research-pool/import")
def import_research_pool(request: Request, file: UploadFile = File(...)):
    raw = file.file.read(research_pool.MAX_UPLOAD_BYTES + 1)
    try:
        return research_pool.import_workbook(request.app.state.repo.store.data_dir, raw, file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

_FLOW_URL = "https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get"
_FLOW_HISTORY_URL = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
_BOARD_KLINE_URL = "https://7.push2his.eastmoney.com/api/qt/stock/kline/get"
_RANK_URL = "https://push2delay.eastmoney.com/api/qt/clist/get"
_FLOW_UT = "b2884a393a59ad64002292a3e90d46a5"
_flow_cache: dict[str, tuple[float, dict]] = {}
_flow_lock = asyncio.Lock()
_history_cache: dict[str, tuple[float, dict]] = {}
_history_lock = asyncio.Lock()
_board_catalog_cache: tuple[float, list[dict]] | None = None
_board_catalog_lock = asyncio.Lock()
_fuyao_board_catalog_cache: tuple[float, list[dict]] | None = None
_fuyao_board_catalog_lock = asyncio.Lock()
# 排除季报/公告/预亏等事件标签，避免被误当成持仓关联行业板块。
_EVENT_BOARD_WORDS = ("季报", "年报", "中报", "首亏", "预亏", "预增", "扭亏", "公告", "减持", "增持", "重组", "摘帽")
_BOARD_SEARCH_TERMS = ("半导体", "材料", "设备", "通信", "算力", "人工智能", "芯片", "光刻胶", "先进封装", "银行", "红利", "建筑装饰")


def _is_linkable_board_name(name: str) -> bool:
    text = str(name or "").strip()
    return bool(text) and not any(word in text for word in _EVENT_BOARD_WORDS)


def _board_keyword_match(item: dict, query: str) -> bool:
    """Match names even when the provider orders compound Chinese terms differently."""
    q = "".join(str(query or "").casefold().split())
    if not q:
        return True
    haystack = "".join(f"{item.get('name', '')} {item.get('code', '')}".casefold().split())
    if q in haystack:
        return True
    terms = [term for term in _BOARD_SEARCH_TERMS if term in q]
    if len(terms) < 2:
        return False
    # “半导体设备材料” may be split by the provider into “半导体设备”
    # and “半导体材料”; return both related candidates instead of zero results.
    matched = sum(term in haystack for term in terms)
    return matched >= max(2, len(terms) - 1)
logger = logging.getLogger(__name__)
_ptrade_upload_times: dict[str, list[float]] = {}


def _previous_weekdays(day: date, count: int) -> list[date]:
    result: list[date] = []
    cursor = day
    while len(result) < count:
        cursor = cursor.fromordinal(cursor.toordinal() - 1)
        if cursor.weekday() < 5:
            result.append(cursor)
    return result


@router.get("/volume-forecast")
async def volume_forecast_for_symbol(
    request: Request,
    symbol: str = Query(..., pattern=r"^\d{6}\.(SH|SZ|SS|BJ)$"),
    trade_date: date | None = Query(None),
):
    """Read real TickFlow minute amount samples and forecast full-day turnover."""
    normalized = symbol.strip().upper().replace(".SS", ".SH")
    day = trade_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if day > datetime.now(ZoneInfo("Asia/Shanghai")).date():
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    capset = request.app.state.capabilities
    if not capset.has(Cap.KLINE_MINUTE_BY_SYMBOL):
        raise HTTPException(status_code=503, detail="分钟行情权限不可用")
    try:
        asset_type = request.app.state.repo.resolve_asset_type(normalized)
        days = [day, *_previous_weekdays(day, 5)]

        def load(selected: date) -> list[dict]:
            frame = fetch_minute_single(normalized, selected, asset_type=asset_type, capset=capset)
            return [{**row, "datetime": str(row["datetime"])} for row in frame.to_dicts()]

        rows = await asyncio.gather(*(asyncio.to_thread(load, selected) for selected in days))
        result = forecast_amount(rows[0], rows[1:])
        result["source"] = f"{selected_minute_source()}分钟成交额"
        return {"symbol": normalized, "trade_date": day.isoformat(), **result}
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"分钟成交额读取失败：{type(exc).__name__}") from exc


@router.get("/market-volume-forecast")
async def market_volume_forecast(request: Request, trade_date: date | None = Query(None)):
    """Forecast full-A turnover from the persisted real minute universe.

    This endpoint intentionally does not substitute index turnover, price change,
    or synthetic bars. Missing current-day or comparable historical partitions
    produce an explicit unavailable response.
    """
    selected = trade_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    while selected.weekday() >= 5:
        selected = selected.fromordinal(selected.toordinal() - 1)
    if selected > today:
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    repo = request.app.state.repo

    def load() -> tuple[list[dict], list[list[dict]], int, list[str]]:
        instruments = repo.get_instruments_asset("stock")
        symbols = [str(value) for value in instruments["symbol"].drop_nulls().to_list()] if not instruments.is_empty() else []
        if not symbols:
            return [], [], 0, []
        current_frame = repo.get_minute_batch(symbols, selected, asset_type="stock")
        current_rows = current_frame.to_dicts() if not current_frame.is_empty() else []
        historical: list[list[dict]] = []
        cursor = selected
        for _ in range(5):
            cursor = cursor.fromordinal(cursor.toordinal() - 1)
            while cursor.weekday() >= 5:
                cursor = cursor.fromordinal(cursor.toordinal() - 1)
            frame = repo.get_minute_batch(symbols, cursor, asset_type="stock")
            rows = frame.to_dicts() if not frame.is_empty() else []
            if rows:
                historical.append(rows)
        covered = len({str(row.get("symbol")) for row in current_rows if row.get("symbol")})
        return current_rows, historical, covered, symbols

    try:
        current_rows, historical, covered_symbols, symbols = await asyncio.to_thread(load)
        result = forecast_market_amount(current_rows, historical)
        result["source"] = f"{selected_minute_source()}全市场分钟分区"
        return {
            **result,
            "trade_date": selected.isoformat(),
            "scope": "全A股票（已落盘分钟分区）",
            "symbol_count": len(symbols),
            "covered_symbol_count": covered_symbols,
            "historical_days_available": len(historical),
            "data_is_real": True,
        }
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"全市场分钟成交额读取失败：{type(exc).__name__}") from exc


@router.post("/decision/assist")
async def decision_assist(request: Request):
    """Risk-first, explainable decision assistance; never places orders."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("请求体必须为 JSON 对象")
        risk_budget = float(payload.pop("risk_budget", 5000))
        # API callers must opt into an explicitly non-strict research preview;
        # the default decision path requires the full market context.
        payload.setdefault("strict_context", True)
        return build_decision(payload, risk_budget=risk_budget)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/ptrade/etf-minute/import")
async def ptrade_import(request: Request):
    """Authenticated, rate-limited CSV upload; never accepts broker credentials."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = [t for t in _ptrade_upload_times.get(ip, []) if now - t < 60]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="一分钟最多上传 5 次")
    recent.append(now)
    _ptrade_upload_times[ip] = recent
    if int(request.headers.get("content-length", "0") or "0") > 300_000:
        raise HTTPException(status_code=413, detail="CSV 超过 300 KB")
    raw = await request.body()
    try:
        result = await asyncio.to_thread(ptrade_replay.save_csv, settings.data_dir, raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", **result}


@router.post("/trades/import")
async def trades_import(request: Request):
    """Import broker/manual fills into the idempotent local transaction ledger."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = [t for t in _ptrade_upload_times.get(f"trades:{ip}", []) if now - t < 60]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="一分钟最多上传 5 次")
    recent.append(now)
    _ptrade_upload_times[f"trades:{ip}"] = recent
    if int(request.headers.get("content-length", "0") or "0") > 300_000:
        raise HTTPException(status_code=413, detail="成交 CSV 超过 300 KB")
    try:
        result = await asyncio.to_thread(ptrade_replay.save_trade_csv, settings.data_dir, await request.body())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", **result}


@router.get("/ptrade/etf-minute/replay")
async def ptrade_etf_replay(symbol: str = Query(...), trade_date: date | None = Query(None), source: str = Query("ptrade", pattern="^(ptrade|public)$")):
    symbol = symbol.strip().upper()
    if not __import__("re").fullmatch(r"\d{6}\.(SH|SZ|SS|BJ)", symbol):
        raise HTTPException(status_code=400, detail="证券代码格式必须为 6 位代码加交易所后缀")
    selected_date = trade_date or date.fromisoformat(ptrade_replay.TARGET_DAY)
    if source == "public":
        from app.api.indices import get_public_index_minute
        public_symbol = symbol.replace(".SS", ".SH")
        result = await get_public_index_minute(symbol=public_symbol, trade_date=selected_date)
        if result.get("display_date") != ptrade_replay.TARGET_DAY:
            return ptrade_replay.replay(symbol, [], trade_date=selected_date.isoformat())
        rows = [{"symbol": symbol, "datetime": row["datetime"].replace(" ", "T") + ":00+08:00",
                 "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"],
                 "volume": row["volume"] * 100, "amount": row["amount"], "source": "eastmoney_public_delayed"}
                for row in result["rows"] if row["datetime"][11:16] != "09:30"]
        return ptrade_replay.replay(symbol, rows, source="东方财富公开延迟行情（非PTrade）", trade_date=selected_date.isoformat(),
                                    trades=await asyncio.to_thread(ptrade_replay.load_trade_rows, settings.data_dir, symbol, selected_date.isoformat()))
    minute_rows = await asyncio.to_thread(ptrade_replay.load, settings.data_dir, symbol, selected_date.isoformat())
    trade_rows = await asyncio.to_thread(ptrade_replay.load_trade_rows, settings.data_dir, symbol, selected_date.isoformat())
    return ptrade_replay.replay(symbol, minute_rows, trade_date=selected_date.isoformat(), trades=trade_rows)


def _parse_flow(lines: list[str]) -> list[dict]:
    rows = []
    for line in lines:
        values = line.split(",")
        if len(values) < 6:
            continue
        try:
            rows.append({
                "time": values[0],
                "main": round(float(values[1]) / 1e8, 3),
                "small": round(float(values[2]) / 1e8, 3),
                "medium": round(float(values[3]) / 1e8, 3),
                "big": round(float(values[4]) / 1e8, 3),
                "super": round(float(values[5]) / 1e8, 3),
            })
        except ValueError:
            continue
    return rows


def _parse_price(lines: list[str], period: str) -> list[dict]:
    bars = []
    for line in lines:
        fields = line.split(",")
        if len(fields) < 7:
            continue
        try:
            date = fields[0]
            open_, close, high, low = (float(value) for value in fields[1:5])
            volume = float(fields[5])
            if not date.startswith("20") or min(open_, close, high, low) <= 0 or low > min(open_, close) or high < max(open_, close):
                continue
            bars.append({"time": date, "open": open_, "close": close, "high": high,
                         "low": low, "volume": volume,
                         "pct": float(fields[8]) if period == "daily" and len(fields) > 8 else None})
        except ValueError:
            continue
    return bars


def _sum_market_flows(sh: list[dict], sz: list[dict]) -> list[dict]:
    by_time: dict[str, dict] = {}
    for row in sh + sz:
        merged = by_time.setdefault(row["time"], {"time": row["time"],
            "main": 0, "super": 0, "big": 0, "medium": 0, "small": 0})
        for field in ("main", "super", "big", "medium", "small"):
            merged[field] += row[field]
    return [{field: round(value, 3) if field != "time" else value for field, value in by_time[day].items()}
            for day in sorted(by_time)]


async def _fetch_daily_flow(client: httpx.AsyncClient, secid: str, days: int) -> list[dict]:
    response = await client.get(_FLOW_HISTORY_URL, params={
        "lmt": str(days), "klt": "101", "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
        "secid": secid,
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0 or not (payload.get("data") or {}).get("klines"):
        raise ValueError(f"历史资金流接口未返回 {secid} 的数据")
    return _parse_flow(payload["data"]["klines"])


async def _fetch_board_price(client: httpx.AsyncClient, sector: str, period: str, days: int) -> tuple[str, list[dict]]:
    klt = {"daily": "101", "1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}[period]
    response = await client.get(_BOARD_KLINE_URL, params={
        "secid": f"90.{sector}", "klt": klt, "fqt": "0", "beg": "19900101" if period == "daily" else "0",
        "end": "20500101", "lmt": str(days if period == "daily" else 120),
        "fields1": "f1,f2,f3,f4,f5,f6", "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    })
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") or {}
    if payload.get("rc") != 0 or not data.get("klines"):
        raise ValueError(f"板块 {sector} 暂无{period}行情")
    bars = _parse_price(data["klines"], period)
    return str(data.get("name") or sector), bars[-days if period == "daily" else -120:]


async def _fetch_flow(client: httpx.AsyncClient, secid: str) -> list[dict]:
    response = await client.get(_FLOW_URL, params={
        "lmt": "0", "klt": "1", "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "ut": _FLOW_UT,
        "secid": secid,
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0 or not (payload.get("data") or {}).get("klines"):
        raise ValueError(f"资金流接口未返回 {secid} 的分时数据")
    return _parse_flow(payload["data"]["klines"])


async def _fetch_ranking(client: httpx.AsyncClient, descending: bool, limit: int = 100) -> list[dict]:
    response = await client.get(_RANK_URL, params={
        "fid": "f62", "po": "1" if descending else "0", "pz": str(limit),
        "pn": "1", "np": "1", "fltt": "2", "invt": "2", "ut": _FLOW_UT,
        "fs": "m:90+t:2", "fields": "f3,f12,f14,f62,f124",
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0:
        raise ValueError("板块资金榜暂不可用")
    items = (payload.get("data") or {}).get("diff") or []
    return [{
        "code": str(item.get("f12") or ""),
        "name": str(item.get("f14") or ""),
        "net_yi": round(float(item.get("f62") or 0) / 1e8, 3),
        "pct": item.get("f3"),
    } for item in items if item.get("f12") and item.get("f14")]


async def _fetch_board_catalog(client: httpx.AsyncClient) -> list[dict]:
    """Load Eastmoney industry/concept boards, not only the current top fund-flow ranks."""
    rows: dict[str, dict] = {}
    for page in range(1, 13):
        response = await client.get(_RANK_URL, params={
            "fid": "f3", "po": "1", "pz": "100", "pn": str(page), "np": "1",
            "fltt": "2", "invt": "2", "ut": _FLOW_UT,
            "fs": "m:90+t:2,m:90+t:3", "fields": "f3,f12,f14",
        })
        response.raise_for_status()
        payload = response.json()
        if payload.get("rc") != 0:
            raise ValueError("板块目录暂不可用")
        items = (payload.get("data") or {}).get("diff") or []
        for item in items:
            code, name = str(item.get("f12") or ""), str(item.get("f14") or "")
            if code.startswith("BK") and name:
                rows[code] = {"code": code, "name": name, "pct": item.get("f3")}
        if len(items) < 100:
            break
    return sorted((item for item in rows.values() if _is_linkable_board_name(item["name"])), key=lambda item: item["name"])


def _configured_fuyao_provider():
    """Return the configured Fuyao provider, without exposing credentials."""
    try:
        from app.data_providers import custom as custom_sources
        if not custom_sources.is_custom_provider("fuyao"):
            return None
        provider = custom_sources.get_provider("fuyao")
        return provider if hasattr(provider, "get_ths_index_catalog") else None
    except (ImportError, RuntimeError, TypeError, ValueError):
        return None


async def _fetch_fuyao_board_catalog() -> list[dict]:
    provider = _configured_fuyao_provider()
    if provider is None:
        return []
    rows: dict[str, dict] = {}
    for tag, kind in (("industry", "industry"), ("cn_concept", "concept")):
        items, _timestamp = await asyncio.to_thread(provider.get_ths_index_catalog, tag)
        for item in items:
            code = str(item.get("thscode") or "").strip().upper()
            name = str(item.get("name") or "").strip()
            if code and name and _is_linkable_board_name(name):
                rows[code] = {"code": code, "name": name, "type": kind, "pct": None}
    return sorted(rows.values(), key=lambda item: item["name"])


async def _fetch_fuyao_board_history(code: str, days: int) -> tuple[str, list[dict], int]:
    provider = _configured_fuyao_provider()
    if provider is None:
        raise ValueError("扶摇未配置或板块接口不可用")
    end = datetime.now(ZoneInfo("Asia/Shanghai"))
    start = end.fromtimestamp(end.timestamp() - 5 * 366 * 86400, tz=ZoneInfo("Asia/Shanghai"))
    raw, timestamp = await asyncio.to_thread(
        provider.get_ths_index_history, code, int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    )
    rows = []
    for row in raw:
        try:
            date_ms = int(row.get("date_ms") or 0)
            if not date_ms:
                continue
            moment = datetime.fromtimestamp(date_ms / 1000, tz=ZoneInfo("Asia/Shanghai"))
            rows.append({
                "time": moment.strftime("%Y-%m-%d"),
                "open": float(row["open_price"]), "close": float(row["close_price"]),
                "high": float(row["high_price"]), "low": float(row["low_price"]),
                "volume": float(row.get("volume") or 0),
                "amount": float(row.get("turnover") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return code, rows[-days:], timestamp


async def _fetch_local_index_history(request: Request, code: str, days: int) -> list[dict]:
    """Read an exchange index/ETF from the local TickFlow-routed daily store."""
    repo = request.app.state.repo
    asset_type = repo.resolve_asset_type(code)
    if asset_type not in {"index", "etf"}:
        asset_type = "index"
    end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    start = end - timedelta(days=5 * 366)
    frame = await asyncio.to_thread(repo.get_daily_asset, asset_type, code, start, end)
    if frame.is_empty():
        raise ValueError("本地没有该指数的TickFlow日K缓存")
    rows = []
    for row in frame.sort("date").tail(days).to_dicts():
        try:
            rows.append({
                "time": str(row["date"]), "open": float(row["open"]), "close": float(row["close"]),
                "high": float(row["high"]), "low": float(row["low"]),
                "volume": float(row.get("volume") or 0), "amount": float(row.get("amount") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    if not rows:
        raise ValueError("本地没有有效的TickFlow指数日K")
    return rows


@router.get("/fund-flow/sectors")
async def fund_flow_sectors(q: str = Query("", max_length=40), limit: int = Query(1200, ge=1, le=1200)):
    """Search THS industry/concept boards first, then fall back to Eastmoney BK boards."""
    global _fuyao_board_catalog_cache
    fuyao_cached = _fuyao_board_catalog_cache
    if not fuyao_cached or time.monotonic() - fuyao_cached[0] >= 1800:
        async with _fuyao_board_catalog_lock:
            fuyao_cached = _fuyao_board_catalog_cache
            if not fuyao_cached or time.monotonic() - fuyao_cached[0] >= 1800:
                try:
                    fuyao_items = await _fetch_fuyao_board_catalog()
                    if fuyao_items:
                        _fuyao_board_catalog_cache = (time.monotonic(), fuyao_items)
                        fuyao_cached = _fuyao_board_catalog_cache
                except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
                    logger.info("扶摇板块目录不可用，回退东方财富: %s", type(exc).__name__)
    if fuyao_cached:
        items = fuyao_cached[1]
        keyword = q.strip().casefold()
        if keyword:
            items = [item for item in items if _board_keyword_match(item, keyword)]
        return {"items": items[:limit], "total": len(items), "source": "扶摇同花顺行业/概念目录"}

    global _board_catalog_cache
    cached = _board_catalog_cache
    if not cached or time.monotonic() - cached[0] >= 600:
        async with _board_catalog_lock:
            cached = _board_catalog_cache
            if not cached or time.monotonic() - cached[0] >= 600:
                try:
                    async with httpx.AsyncClient(timeout=15.0) as client:
                        items = await _fetch_board_catalog(client)
                    _board_catalog_cache = (time.monotonic(), items)
                    cached = _board_catalog_cache
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                    if not cached:
                        raise HTTPException(status_code=502, detail=f"板块目录暂不可用：{type(exc).__name__}") from exc
    items = cached[1]
    keyword = q.strip().casefold()
    if keyword:
        items = [item for item in items if _board_keyword_match(item, keyword)]
    return {"items": items[:limit], "total": len(items), "source": "东方财富公开板块目录（扶摇不可用时兜底）"}


@router.get("/fund-flow/live")
async def fund_flow_live(sector: str | None = Query(None, pattern=r"^BK\d{4}$")):
    """东方财富公开延迟行情；60 秒轮询，返回原始数据时点供前端辨别新旧。"""
    key = sector or "market"
    cached = _flow_cache.get(key)
    if cached and time.monotonic() - cached[0] < 55:
        return cached[1]
    async with _flow_lock:
        cached = _flow_cache.get(key)
        if cached and time.monotonic() - cached[0] < 55:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                if sector:
                    rows = await _fetch_flow(client, f"90.{sector}")
                else:
                    sh, sz = await asyncio.gather(
                        _fetch_flow(client, "1.000001"),
                        _fetch_flow(client, "0.399001"),
                    )
                    rows = _sum_market_flows(sh, sz)
                rank_results = await asyncio.gather(
                    _fetch_ranking(client, True), _fetch_ranking(client, False),
                    return_exceptions=True,
                )
            if not rows:
                raise ValueError("资金流接口暂无分时数据")
            now = datetime.now(ZoneInfo("Asia/Shanghai"))
            latest = rows[-1]["time"]
            in_rank = rank_results[0] if isinstance(rank_results[0], list) else []
            out_rank = rank_results[1] if isinstance(rank_results[1], list) else []
            result = {
                "mode": "sector" if sector else "market", "sector": sector,
                "sector_name": next((x["name"] for x in in_rank + out_rank if x["code"] == sector), sector) if sector else None,
                "rows": rows,
                "latest_time": latest,
                "fetched_at": now.isoformat(timespec="seconds"),
                "is_today": latest[:10] == now.date().isoformat(),
                "stale": False,
                "source": "东方财富公开延迟资金流（push2delay）",
                "inflow": in_rank, "outflow": out_rank,
            }
            _flow_cache[key] = (time.monotonic(), result)
            if result["is_today"]:
                try:
                    await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir, key, rows, result["fetched_at"])
                except (OSError, ValueError, sqlite3.Error) as exc:
                    logger.warning("fund flow archive write failed: %s", exc)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"资金流数据暂不可用：{type(exc).__name__}") from exc


@router.get("/fund-flow/day")
async def fund_flow_day(
    date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    sector: str | None = Query(None, pattern=r"^BK\d{4}$"),
):
    """A past day's genuine archived minute curve, or today's live minute curve."""
    try:
        selected = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="交易日期格式不正确") from exc
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if selected > today:
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    code = sector or "market"
    if selected == today:
        live = await fund_flow_live(sector=sector)
        if live["latest_time"][:10] == date:
            return {"status": "ok", "date": date, "sector": sector, "rows": live["rows"],
                    "latest_time": live["latest_time"], "fetched_at": live["fetched_at"],
                    "source": live["source"], "stale": live["stale"], "mode": live["mode"]}
    stored = await asyncio.to_thread(fund_flow_archive.load_day, settings.data_dir, code, date)
    if stored:
        return {"status": "ok", "date": date, "sector": sector, "rows": stored["rows"],
                "latest_time": stored["rows"][-1]["time"], "fetched_at": stored["fetched_at"],
                "source": "本机归档的东方财富分钟资金流", "stale": True,
                "mode": "sector" if sector else "market"}
    return {"status": "not_recorded", "date": date, "sector": sector, "rows": [],
            "notice": "该日没有归档的分钟资金记录；公开接口只提供最近交易日，无法从日终净额还原盘中曲线。"}


async def _archive_after_close() -> dict:
    """Once after close, retain market and the ranked industry boards for future day inspection."""
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    fetched_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    saved = 0
    async with httpx.AsyncClient(timeout=12.0) as client:
        sh, sz = await asyncio.gather(_fetch_flow(client, "1.000001"), _fetch_flow(client, "0.399001"))
        market_rows = _sum_market_flows(sh, sz)
        if market_rows and market_rows[-1]["time"][:10] == today:
            saved += int(await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir,
                                                   "market", market_rows, fetched_at))
        ranks = await asyncio.gather(_fetch_ranking(client, True, 16), _fetch_ranking(client, False, 16), return_exceptions=True)
        codes = list(dict.fromkeys(row["code"] for group in ranks if isinstance(group, list) for row in group))
        limit = asyncio.Semaphore(4)

        async def save_sector(code: str) -> int:
            async with limit:
                try:
                    rows = await _fetch_flow(client, f"90.{code}")
                    if rows and rows[-1]["time"][:10] == today:
                        return int(await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir,
                                                           code, rows, fetched_at))
                except (httpx.HTTPError, ValueError, OSError, sqlite3.Error) as exc:
                    logger.warning("fund flow archive skipped %s: %s", code, exc)
                return 0

        saved += sum(await asyncio.gather(*(save_sector(code) for code in codes)))
    return {"date": today, "saved_scopes": saved}


def archive_after_close() -> None:
    try:
        logger.info("fund flow archive: %s", asyncio.run(_archive_after_close()))
    except (httpx.HTTPError, ValueError, OSError, sqlite3.Error) as exc:
        logger.warning("fund flow archive failed: %s", exc)


@router.get("/fund-flow/history")
async def fund_flow_history(
    sector: str | None = Query(None, pattern=r"^BK\d{4}$"),
    days: int = Query(60, ge=10, le=120),
):
    """Completed daily fund-flow bars; the market series is Shanghai + Shenzhen by date."""
    key = f"flow:{sector or 'market'}:{days}"
    cached = _history_cache.get(key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    async with _history_lock:
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 600:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                if sector:
                    rows = await _fetch_daily_flow(client, f"90.{sector}", days)
                else:
                    sh, sz = await asyncio.gather(
                        _fetch_daily_flow(client, "1.000001", days),
                        _fetch_daily_flow(client, "0.399001", days),
                    )
                    rows = _sum_market_flows(sh, sz)
            if not rows:
                raise ValueError("暂无历史资金流数据")
            result = {"mode": "sector" if sector else "market", "sector": sector, "rows": rows[-days:],
                      "latest_time": rows[-1]["time"], "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "source": "东方财富历史日资金流", "unit": "亿元"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"历史资金流暂不可用：{type(exc).__name__}") from exc


@router.get("/fund-flow/sector-kline")
async def sector_kline(
    request: Request,
    sector: str = Query(..., pattern=r"^(?:BK\d{4}|\d{6}\.(?:TI|SH|SZ))$"),
    period: str = Query("daily", pattern=r"^(daily|1m|5m|15m|30m|60m)$"),
    days: int = Query(60, ge=10, le=120),
):
    """Use TickFlow-routed local bars for exchange indices, Fuyao for THS boards."""
    if re.fullmatch(r"\d{6}\.(?:SH|SZ)", sector.upper()):
        key = f"tickflow-kline:{sector}:{days}"
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        if period != "daily":
            raise HTTPException(status_code=503, detail="当前指数分钟板块曲线请使用指数行情组件；板块接口仅提供日K")
        try:
            rows = await _fetch_local_index_history(request, sector.upper(), days)
            result = {"sector": sector.upper(), "name": sector.upper(), "period": "daily", "rows": rows,
                      "latest_time": rows[-1]["time"],
                      "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "tickflow",
                      "source": "TickFlow日K缓存"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"TickFlow指数日K暂不可用：{type(exc).__name__}") from exc

    if re.fullmatch(r"\d{6}\.TI", sector.upper()):
        if period != "daily":
            raise HTTPException(status_code=503, detail="扶摇当前仅开放板块日K；板块分钟行情尚未开放外部接口")
        key = f"fuyao-kline:{sector}:{days}"
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        try:
            code, rows, timestamp = await _fetch_fuyao_board_history(sector.upper(), days)
            if not rows:
                raise ValueError("扶摇未返回该板块历史行情")
            result = {"sector": code, "name": code, "period": "daily", "rows": rows,
                      "latest_time": rows[-1]["time"],
                      "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "fuyao",
                      "source": "扶摇同花顺行业/概念指数日K", "server_timestamp": timestamp}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"扶摇板块日K暂不可用：{type(exc).__name__}") from exc

    key = f"kline:{sector}:{period}:{days if period == 'daily' else 120}"
    ttl = 45 if period != "daily" else 300
    cached = _history_cache.get(key)
    if cached and time.monotonic() - cached[0] < ttl:
        return cached[1]
    async with _history_lock:
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < ttl:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                name, rows = await _fetch_board_price(client, sector, period, days)
            if not rows:
                raise ValueError("板块行情没有有效K线")
            result = {"sector": sector, "name": name, "period": period, "rows": rows,
                      "latest_time": rows[-1]["time"], "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "eastmoney",
                      "source": "东方财富公开板块行情（可能延迟）"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"板块K线暂不可用：{type(exc).__name__}") from exc

@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_myagent(path: str, request: Request):
    if not (path.startswith("quant/") or path in {"chat", "config"}):
        return Response('{"detail":"Not Found"}', status_code=404, media_type="application/json")
    token = os.getenv("MYAGENT_ADMIN_TOKEN", "").strip()
    if not token:
        return Response('{"detail":"MyAgent bridge is not configured"}', status_code=503, media_type="application/json")
    query = str(request.url.query)
    base_url = os.getenv("MYAGENT_BRIDGE_URL", "http://myagent:8000").rstrip("/")
    url = f"{base_url}/api/{path}" + (f"?{query}" if query else "")
    body = await request.body()
    headers = {"X-Admin-Token": token}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.request(request.method, url, content=body, headers=headers)
        return Response(content=upstream.content, status_code=upstream.status_code,
                        media_type=upstream.headers.get("content-type", "application/json"))
    except httpx.HTTPError:
        return Response('{"detail":"MyAgent bridge unavailable"}', status_code=502, media_type="application/json")
