"""受 TickFlow 登录保护的 MyAgent 量化模型桥接。"""
from __future__ import annotations

import os
import asyncio
import logging
import sqlite3
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo
import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from app.config import settings
from app.services import fund_flow_archive
from app.services import ptrade_replay

router = APIRouter(prefix="/api/myagent", tags=["myagent-bridge"])

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
# 排除季报/公告/预亏等事件标签，避免被误当成持仓关联行业板块。
_EVENT_BOARD_WORDS = ("季报", "年报", "中报", "首亏", "预亏", "预增", "扭亏", "公告", "减持", "增持", "重组", "摘帽")


def _is_linkable_board_name(name: str) -> bool:
    text = str(name or "").strip()
    return bool(text) and not any(word in text for word in _EVENT_BOARD_WORDS)
logger = logging.getLogger(__name__)
_ptrade_upload_times: dict[str, list[float]] = {}


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


@router.get("/ptrade/etf-minute/replay")
async def ptrade_etf_replay(symbol: str = Query(...), source: str = Query("ptrade", pattern="^(ptrade|public)$")):
    if symbol not in ptrade_replay.SYMBOLS:
        raise HTTPException(status_code=400, detail="首批仅支持 159558.SZ 与 588080.SS")
    if source == "public":
        from app.api.indices import get_public_index_minute
        public_symbol = symbol.replace(".SS", ".SH")
        result = await get_public_index_minute(symbol=public_symbol, trade_date=date(2026, 11, 6))
        if result.get("display_date") != ptrade_replay.TARGET_DAY:
            return ptrade_replay.replay(symbol, [])
        rows = [{"symbol": symbol, "datetime": row["datetime"].replace(" ", "T") + ":00+08:00",
                 "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"],
                 "volume": row["volume"] * 100, "amount": row["amount"], "source": "eastmoney_public_delayed"}
                for row in result["rows"] if row["datetime"][11:16] != "09:30"]
        return ptrade_replay.replay(symbol, rows, source="东方财富公开延迟行情（非PTrade）")
    rows = await asyncio.to_thread(ptrade_replay.load, settings.data_dir, symbol)
    return ptrade_replay.replay(symbol, rows)


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
    klt = {"daily": "101", "1m": "1", "5m": "5", "15m": "15"}[period]
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


@router.get("/fund-flow/sectors")
async def fund_flow_sectors(q: str = Query("", max_length=40), limit: int = Query(1200, ge=1, le=1200)):
    """Searchable Eastmoney board catalog for user-defined holding links."""
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
        items = [item for item in items if keyword in f"{item['name']} {item['code']}".casefold()]
    return {"items": items[:limit], "total": len(items), "source": "东方财富公开板块目录"}


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
    sector: str = Query(..., pattern=r"^BK\d{4}$"),
    period: str = Query("daily", pattern=r"^(daily|1m|5m|15m)$"),
    days: int = Query(60, ge=10, le=120),
):
    """Public sector quote bars; minute candles use the last 120 bars, daily may include today's partial candle."""
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
                      "stale": False, "source": "东方财富公开板块行情"}
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
