"""Read-only A-share scanner and daily K-line adapter.

The public quote endpoints are isolated here so a licensed provider can later
replace them without changing the API or UI. There is no trading capability.
"""

from __future__ import annotations

import math
import json
import os
import re
import statistics
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from ..quant_reference import SECTOR_REFERENCE, sector_for_name

SPOT_URL = "https://push2.eastmoney.com/api/qt/clist/get"
KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
SINA_SPOT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
SINA_COUNT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount"
SINA_KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_myagent=/CN_MarketDataService.getKLineData"
TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="
EASTMONEY_SUGGEST_URL = "https://searchapi.eastmoney.com/api/suggest/get"
MARKET_FILTER = "m:0+t:6,m:0+t:80,m:0+t:81+s:2048,m:1+t:2,m:1+t:23"
HEADERS = {"User-Agent": "Mozilla/5.0 MyAgent/0.2", "Referer": "https://quote.eastmoney.com/"}
_cache_lock = threading.Lock()
_akshare_lock = threading.Lock()
_akshare_client = None
_spot_cache: tuple[float, list[dict]] = (0.0, [])
_universe_cache: tuple[float, list[str]] = (0.0, [])
_scan_cache: dict[tuple, tuple[float, dict]] = {}
_fund_flow_cache: tuple[float, dict] = (0.0, {})
_symbol_lookup_cache: dict[str, str] = {}
HISTORY_CACHE_DIR = Path(__file__).parents[2] / "data" / "quant_cache"
HISTORY_CACHE_SECONDS = 12 * 60 * 60


class MarketDataError(RuntimeError):
    pass


def get_tickflow_context(symbols: list[str] | tuple[str, ...], days: int = 60) -> dict:
    """Fetch the shared TickFlow context for server-side AI enrichment.

    The bridge token and URL are server environment variables; neither is
    exposed to the browser. An unavailable bridge is a soft failure so the
    existing public-market adapter keeps working.
    """
    base = (os.getenv("TICKFLOW_BRIDGE_URL") or "").strip().rstrip("/")
    token = (os.getenv("TICKFLOW_BRIDGE_TOKEN") or "").strip()
    if not base or not token:
        return {}
    values = []
    for symbol in symbols:
        text = str(symbol).strip().upper()
        if text and text not in values:
            values.append(text)
    try:
        response = httpx.get(
            f"{base}/api/bridge/context",
            params={"symbols": ",".join(values[:12]), "days": max(20, min(int(days), 200))},
            headers={"X-TickFlow-Bridge-Token": token, **HEADERS},
            timeout=20.0,
            follow_redirects=True,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}
    except (httpx.HTTPError, ValueError, TypeError):
        return {}


def get_tickflow_portfolio(path: str, params: dict) -> dict:
    """Read source-labelled quotes or minute bars over the existing private bridge."""
    base = (os.getenv("TICKFLOW_BRIDGE_URL") or "").strip().rstrip("/")
    token = (os.getenv("TICKFLOW_BRIDGE_TOKEN") or "").strip()
    if path not in {"portfolio-quotes", "portfolio-minute", "portfolio-minute-batch"}:
        raise MarketDataError("TickFlow 行情路径无效")
    bridge_error: Exception | None = None
    if base and token:
        try:
            response = httpx.get(
                f"{base}/api/bridge/{path}", params=params,
                headers={"X-TickFlow-Bridge-Token": token}, timeout=25.0,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("invalid response")
            return payload
        except (httpx.HTTPError, ValueError) as exc:
            bridge_error = exc
    # Keep the workstation useful while the paid TickFlow key is absent or its
    # entitlement probe fails.  The fallback is always labelled and never
    # presented as licensed TickFlow or exchange-direct data.
    try:
        return _public_portfolio_fallback(path, params)
    except (MarketDataError, ValueError, TypeError) as exc:
        raise MarketDataError("TickFlow 与公开备用行情均暂不可用") from (bridge_error or exc)


def _public_portfolio_fallback(path: str, params: dict) -> dict:
    if path == "portfolio-quotes":
        symbols = [part.strip().upper().replace(".SS", ".SH") for part in str(params.get("symbols") or "").split(",") if part.strip()]
        if not symbols or len(symbols) > 100:
            raise ValueError("invalid symbols")
        snapshot = live_snapshot([symbol[:6] for symbol in symbols])
        by_code = {str(row.get("symbol")): row for row in snapshot.get("items") or []}
        items = []
        for symbol in symbols:
            row = by_code.get(symbol[:6], {})
            items.append({
                "symbol": symbol, "name": row.get("name"), "price": row.get("price"),
                "prev_close": row.get("prev_close"), "high": row.get("high"), "low": row.get("low"),
                "amount": row.get("amount"), "volume": row.get("volume"),
                "timestamp": snapshot.get("generated_at"), "change_pct": row.get("pct"),
            })
        return {"source": snapshot.get("source") or "公开行情（非 TickFlow Pro）", "items": items,
                "notice": "TickFlow Key/权限未生效，已使用明确标注的公开行情备用源。"}

    if path == "portfolio-minute":
        symbol = str(params.get("symbol") or "").strip().upper().replace(".SS", ".SH")
        if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", symbol):
            raise ValueError("invalid symbol")
        trade_date = str(params.get("trade_date") or date.today().isoformat())
        day = date.fromisoformat(trade_date)
        result = get_intraday_kline(symbol[:6], period=1, limit=1000, trade_date=day.isoformat())
        rows = [{
            "datetime": row["date"], "open": row["open"], "high": row["high"],
            "low": row["low"], "close": row["close"], "volume": row["volume"],
            "amount": row.get("amount"), "source": "public_fallback",
        } for row in result.get("bars") or [] if str(row.get("date", "")).startswith(day.isoformat())]
        return {"symbol": symbol, "trade_date": day.isoformat(), "asset_type": "unverified",
                "source": result.get("realtime_level") or "东方财富/新浪公开分钟行情（非 TickFlow Pro）",
                "rows": rows, "last_market_time": rows[-1]["datetime"] if rows else None,
                "replay": None, "notice": "公开备用源，非交易所逐笔，不代表 TickFlow 付费权限已生效。"}

    symbols = [part.strip().upper().replace(".SS", ".SH") for part in str(params.get("symbols") or "").split(",") if part.strip()]
    if not symbols or len(symbols) > 30:
        raise ValueError("公开备用源单次最多 30 只")
    day = str(params.get("trade_date") or date.today().isoformat())
    data = {}
    for symbol in symbols:
        data[symbol] = _public_portfolio_fallback("portfolio-minute", {"symbol": symbol, "trade_date": day})["rows"]
    return {"trade_date": day, "source": "东方财富/新浪公开分钟行情（非 TickFlow Pro）", "data": data,
            "request_count": len(symbols), "symbol_count": len(symbols),
            "notice": "TickFlow 批量权限未生效；当前为逐标的公开备用源。"}


def _get_akshare():
    """Import AKShare exactly once; concurrent first-import can crash mini_racer on Windows."""
    global _akshare_client
    if _akshare_client is not None:
        return _akshare_client
    with _akshare_lock:
        if _akshare_client is None:
            try:
                import akshare as ak
            except Exception as exc:
                raise MarketDataError("AKShare 未正确安装") from exc
            _akshare_client = ak
    return _akshare_client


def _number(value, default=0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def _get_json(url: str, params: dict) -> dict:
    last_error = None
    for attempt in range(3):
        try:
            response = httpx.get(url, params=params, headers=HEADERS, timeout=15.0, follow_redirects=True)
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload, dict) and payload.get("data") is not None:
                return payload["data"]
            last_error = ValueError("invalid market payload")
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
        time.sleep(0.25 * (attempt + 1))
    raise MarketDataError("行情源暂时不可用，请稍后重试") from last_error


def _spot_page(page: int) -> dict:
    return _get_json(SPOT_URL, {
        "pn": page, "pz": 100, "po": 1, "np": 1, "fltt": 2, "invt": 2,
        "fid": "f12", "fs": MARKET_FILTER,
        "fields": "f12,f14,f2,f3,f5,f6,f8,f10,f20",
    })


def _sina_spot_page(page: int) -> list[dict]:
    data = _get_json_raw(SINA_SPOT_URL, {"page": page, "num": 100, "sort": "symbol", "asc": 1, "node": "hs_a", "symbol": ""})
    rows = []
    for item in data if isinstance(data, list) else []:
        price = _number(item.get("trade"))
        float_shares = _number(item.get("nmc")) * 10_000 / price if price > 0 else 0
        rows.append({
            "f12": item.get("code"), "f14": item.get("name"), "f2": price,
            "f3": _number(item.get("changepercent")), "f5": _number(item.get("volume")),
            "f8": _number(item.get("turnoverratio")), "f10": 0,
            "f20": _number(item.get("mktcap")) * 10_000,
            "_float_shares": float_shares, "_source": "sina",
        })
    return rows


def _get_json_raw(url: str, params: dict):
    last_error = None
    for attempt in range(3):
        try:
            response = httpx.get(url, params=params, headers=HEADERS, timeout=15.0, follow_redirects=True)
            response.raise_for_status()
            if "sina.com.cn" in url:
                response.encoding = "gbk"
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            time.sleep(0.25 * (attempt + 1))
    raise MarketDataError("备用行情源暂时不可用") from last_error


def _all_sina_spots(enrich: bool = True) -> list[dict]:
    total = int(_get_json_raw(SINA_COUNT_URL, {"node": "hs_a"}))
    pages = max(1, math.ceil(total / 100))
    rows = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(_sina_spot_page, page) for page in range(1, pages + 1)]
        for future in as_completed(futures):
            rows.extend(future.result())
    if enrich:
        _enrich_tencent_volume_ratio(rows)
    return rows


def _enrich_tencent_volume_ratio(rows: list[dict]) -> None:
    """Add live volume ratio in batches; failure only reduces prefilter quality."""
    by_code = {str(row.get("f12")): row for row in rows}
    symbols = []
    for code in by_code:
        prefix = "sh" if code.startswith(("5", "6")) else "bj" if code.startswith(("4", "8", "9")) else "sz"
        symbols.append(prefix + code)

    def fetch(batch: list[str]) -> None:
        try:
            response = httpx.get(TENCENT_QUOTE_URL + ",".join(batch), headers=HEADERS, timeout=15.0, follow_redirects=True)
            response.raise_for_status()
            for line in response.text.split(";"):
                if '="' not in line:
                    continue
                fields = line.split('="', 1)[1].rstrip('"\r\n').split("~")
                if len(fields) > 49 and fields[2] in by_code:
                    by_code[fields[2]]["f10"] = _number(fields[49])
        except httpx.HTTPError:
            return

    batches = [symbols[i:i + 80] for i in range(0, len(symbols), 80)]
    with ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(fetch, batches))


def all_a_share_spots(force: bool = False) -> list[dict]:
    global _spot_cache
    with _cache_lock:
        if not force and time.time() - _spot_cache[0] < 90 and _spot_cache[1]:
            return list(_spot_cache[1])
    try:
        first = _spot_page(1)
        rows = list(first.get("diff") or [])
        pages = max(1, math.ceil(int(first.get("total") or len(rows)) / 100))
        if pages > 1:
            with ThreadPoolExecutor(max_workers=16) as pool:
                futures = [pool.submit(_spot_page, page) for page in range(2, pages + 1)]
                for future in as_completed(futures):
                    rows.extend(future.result().get("diff") or [])
    except MarketDataError:
        rows = _all_sina_spots()
    unique = {str(row.get("f12")): row for row in rows if row.get("f12")}
    result = list(unique.values())
    with _cache_lock:
        _spot_cache = (time.time(), result)
    return list(result)


def _secid(symbol: str) -> str:
    if not symbol.isdigit() or len(symbol) != 6:
        raise ValueError("股票代码必须是 6 位数字")
    return ("1." if symbol.startswith(("5", "6")) else "0.") + symbol


def get_daily_kline(symbol: str, limit: int = 120) -> dict:
    limit = max(20, min(int(limit), 260))
    begin = (date.today() - timedelta(days=max(220, limit * 2))).strftime("%Y%m%d")
    try:
        data = _get_json(KLINE_URL, {
            "secid": _secid(symbol),
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": 101, "fqt": 1, "beg": begin, "end": "20500101", "lmt": limit,
        })
    except MarketDataError:
        return _sina_daily_kline(symbol, limit)
    bars = []
    for raw in data.get("klines") or []:
        parts = raw.split(",")
        if len(parts) < 11:
            continue
        bars.append({
            "date": parts[0], "open": _number(parts[1]), "close": _number(parts[2]),
            "high": _number(parts[3]), "low": _number(parts[4]), "volume": _number(parts[5]),
            "amount": _number(parts[6]), "pct": _number(parts[8]), "turnover": _number(parts[10]),
        })
    return {"symbol": symbol, "name": data.get("name") or symbol, "bars": bars[-limit:]}


def get_intraday_kline(symbol: str, period: int = 1, limit: int = 240, trade_date: str | None = None) -> dict:
    """Return public intraday bars. These are display quotes, not exchange-direct ticks."""
    period = int(period)
    if period not in {1, 5, 15, 30, 60}:
        raise ValueError("分时周期仅支持 1、5、15、30、60 分钟")
    limit = max(20, min(int(limit), 1000))
    selected_day = date.fromisoformat(trade_date) if trade_date else date.today()
    selected = selected_day.strftime("%Y%m%d")
    try:
        data = _get_json(KLINE_URL, {
            "secid": _secid(symbol), "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": period, "fqt": 1, "beg": selected, "end": selected, "lmt": limit,
        })
    except MarketDataError:
        return _sina_intraday_kline(symbol, period, limit, selected_day.isoformat())
    bars = []
    for raw in data.get("klines") or []:
        parts = raw.split(",")
        if len(parts) < 11:
            continue
        bars.append({
            "date": parts[0], "open": _number(parts[1]), "close": _number(parts[2]),
            "high": _number(parts[3]), "low": _number(parts[4]), "volume": _number(parts[5]),
            "amount": _number(parts[6]), "pct": _number(parts[8]), "turnover": _number(parts[10]),
        })
    bars = [row for row in bars if str(row.get("date", "")).startswith(selected_day.isoformat())]
    return {"symbol": symbol, "name": data.get("name") or symbol, "period": period, "bars": bars[-limit:], "realtime_level": "东方财富公开分钟行情（非 TickFlow Pro/QMT）"}


def _sina_intraday_kline(symbol: str, period: int, limit: int, trade_date: str | None = None) -> dict:
    """Fallback minute bars when the primary public endpoint rate-limits the server."""
    prefix = "sh" if symbol.startswith(("5", "6")) else "bj" if symbol.startswith(("4", "8", "9")) else "sz"
    try:
        response = httpx.get(
            SINA_KLINE_URL,
            params={"symbol": prefix + symbol, "scale": period, "ma": "no", "datalen": limit},
            headers=HEADERS, timeout=15.0, follow_redirects=True,
        )
        response.raise_for_status()
        text = response.text
        start, end = text.find("(["), text.rfind("])")
        raw_rows = json.loads(text[start + 1:end + 1]) if start >= 0 and end > start else []
    except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
        raise MarketDataError("分时行情暂时不可用") from exc
    bars, previous = [], 0.0
    for row in raw_rows:
        close = _number(row.get("close"))
        pct = (close / previous - 1) * 100 if previous > 0 else 0
        bars.append({
            "date": row.get("day", ""), "open": _number(row.get("open")), "close": close,
            "high": _number(row.get("high")), "low": _number(row.get("low")),
            "volume": _number(row.get("volume")), "amount": 0, "pct": pct, "turnover": 0,
        })
        previous = close
    if trade_date:
        bars = [row for row in bars if str(row.get("date", "")).startswith(trade_date)]
    if not bars:
        raise MarketDataError("分时行情暂时不可用")
    return {"symbol": symbol, "name": symbol, "period": period, "bars": bars[-limit:],
            "realtime_level": "新浪公开分钟行情（备用，非 TickFlow Pro/QMT）"}


def market_heatmap() -> dict:
    """Build a cap-weighted snapshot for the curated sector library."""
    rows = all_a_share_spots()
    stocks, sector_totals = [], {}
    for row in rows:
        name = str(row.get("f14") or "")
        sector = sector_for_name(name)
        cap_yi = _number(row.get("f20")) / 100_000_000
        item = {"symbol": str(row.get("f12") or ""), "name": name, "sector": sector,
                "price": _number(row.get("f2")), "pct": _number(row.get("f3")), "market_cap_yi": round(cap_yi, 2)}
        if sector != "其他":
            stocks.append(item)
            bucket = sector_totals.setdefault(sector, {"sector": sector, "market_cap_yi": 0.0, "weighted_move": 0.0, "count": 0})
            bucket["market_cap_yi"] += max(cap_yi, 0)
            bucket["weighted_move"] += _number(row.get("f3")) * max(cap_yi, 0)
            bucket["count"] += 1
    sectors = []
    for bucket in sector_totals.values():
        cap = bucket.pop("market_cap_yi")
        weighted = bucket.pop("weighted_move")
        sectors.append({**bucket, "market_cap_yi": round(cap, 2), "pct": round(weighted / cap, 2) if cap else 0})
    stocks.sort(key=lambda item: item["market_cap_yi"], reverse=True)
    sectors.sort(key=lambda item: item["market_cap_yi"], reverse=True)
    now_cn = datetime.now(ZoneInfo("Asia/Shanghai"))
    minute = now_cn.hour * 60 + now_cn.minute
    is_live = now_cn.weekday() < 5 and ((9 * 60 + 15) <= minute <= (11 * 60 + 30) or 13 * 60 <= minute <= 15 * 60)
    return {"generated_at": now_cn.strftime("%Y-%m-%d %H:%M:%S"), "period": "day", "qmt_connected": False,
            "is_live": is_live, "refresh_seconds": 30 if is_live else 0,
            "source": "东方财富公开实时行情（非QMT）" if is_live else "东方财富公开收盘行情（非QMT）",
            "sectors": sectors, "stocks": stocks,
            "notice": "公开源约30秒刷新；5/15分钟全市场历史涨跌与五档盘口需连接QMT。"}


def live_snapshot(symbols: list[str] | None = None) -> dict:
    """Return a small live quote snapshot for cockpit/widgets.

    Tencent is used for batched selected quotes because it is lightweight and
    public.  The full-market heatmap continues to use Eastmoney's public
    universe endpoint so the two views can be refreshed independently.
    """
    requested = list(dict.fromkeys(str(code) for code in (symbols or []) if str(code).isdigit() and len(str(code)) == 6))
    if requested:
        quotes = quote_symbols(requested)
    else:
        rows = all_a_share_spots()
        quotes = {}
        for row in rows:
            code = str(row.get("f12") or "")
            if not code:
                continue
            quotes[code] = {"symbol": code, "name": row.get("f14") or code,
                            "price": _number(row.get("f2")), "pct": _number(row.get("f3")),
                            "turnover": _number(row.get("f8")), "volume_ratio": _number(row.get("f10")),
                            "market_cap_yi": round(_number(row.get("f20")) / 100_000_000, 2),
                            "source": "东方财富公开行情"}
    items = list(quotes.values())
    for item in items:
        item.setdefault("source", "腾讯公开行情")
    items = [item for item in items if _number(item.get("price")) > 0]
    now_cn = datetime.now(ZoneInfo("Asia/Shanghai"))
    minute = now_cn.hour * 60 + now_cn.minute
    is_live = now_cn.weekday() < 5 and ((9 * 60 + 15) <= minute <= (11 * 60 + 30) or 13 * 60 <= minute <= 15 * 60)
    return {"generated_at": now_cn.strftime("%Y-%m-%d %H:%M:%S"), "items": items,
            "source": "腾讯/东方财富公开行情（非QMT）", "is_live": is_live,
            "refresh_seconds": 15 if is_live else 0,
            "notice": "盘中为公开源快照，不等同交易所逐笔行情；QMT接入后可替换为增量推送。"}


def fund_flow_snapshot() -> dict:
    """Return public market and sector fund-flow tables from AKShare/Eastmoney."""
    global _fund_flow_cache
    if time.time() - _fund_flow_cache[0] < 90 and _fund_flow_cache[1]:
        return _fund_flow_cache[1]
    try:
        ak = _get_akshare()
        market_df = ak.stock_market_fund_flow()
        sector_df = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流")
        market_rows = json.loads(market_df.tail(20).to_json(orient="records", force_ascii=False))
        sector_rows = json.loads(sector_df.head(40).to_json(orient="records", force_ascii=False))
    except Exception as exc:
        raise MarketDataError("资金流向暂时不可用，请稍后刷新或检查 AKShare 数据源") from exc
    result = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "market": market_rows,
              "sectors": sector_rows, "source": "AKShare / 东方财富资金流向",
              "notice": "公开资金流向存在延迟；QMT接入后再替换为实时推送。"}
    _fund_flow_cache = (time.time(), result)
    return result


def quote_symbols(symbols: list[str]) -> dict[str, dict]:
    """Return batched Tencent quote snapshots keyed by six-digit symbol."""
    valid = list(dict.fromkeys(str(code) for code in symbols if str(code).isdigit() and len(str(code)) == 6))
    if not valid:
        return {}
    market_symbols = [("sh" if code.startswith(("5", "6")) else "bj" if code.startswith(("4", "8", "9")) else "sz") + code for code in valid]
    def fetch(batch: list[str]) -> dict[str, dict]:
        try:
            response = httpx.get(TENCENT_QUOTE_URL + ",".join(batch), headers=HEADERS, timeout=12.0, follow_redirects=True)
            response.raise_for_status()
            response.encoding = "gbk"
        except httpx.HTTPError:
            return {}
        parsed = {}
        for line in response.text.split(";"):
            if '="' not in line:
                continue
            fields = line.split('="', 1)[1].rstrip('"\r\n').split("~")
            if len(fields) > 49 and fields[2]:
                parsed[fields[2]] = {"symbol": fields[2], "name": fields[1], "price": _number(fields[3]),
                                      "previous_close": _number(fields[4]), "change": _number(fields[31]),
                                      "pct": _number(fields[32]), "turnover": _number(fields[38]),
                                      "volume_ratio": _number(fields[49]), "market_cap_yi": round(_number(fields[44]), 2)}
        return parsed
    batches = [market_symbols[index:index + 80] for index in range(0, len(market_symbols), 80)]
    result = {}
    with ThreadPoolExecutor(max_workers=min(12, len(batches))) as pool:
        for partial in pool.map(fetch, batches):
            result.update(partial)
    if not result:
        raise MarketDataError("公开实时行情暂时不可用")
    return result


def depth_quote(symbol: str) -> dict:
    """Return Tencent public level-5 quote data for one A-share symbol."""
    code = str(symbol)
    if not code.isdigit() or len(code) != 6:
        raise ValueError("股票代码必须是 6 位数字")
    prefix = "sh" if code.startswith(("5", "6")) else "bj" if code.startswith(("4", "8", "9")) else "sz"
    try:
        response = httpx.get(TENCENT_QUOTE_URL + prefix + code, headers=HEADERS, timeout=12.0, follow_redirects=True)
        response.raise_for_status()
        response.encoding = "gbk"
    except httpx.HTTPError as exc:
        raise MarketDataError("公开盘口暂时不可用") from exc
    line = next((x for x in response.text.split(";") if '="' in x), "")
    fields = line.split('="', 1)[1].rstrip('"\r\n').split("~") if '="' in line else []
    if len(fields) < 29 or fields[2] != code:
        raise MarketDataError("公开盘口没有返回有效数据")
    bids = [{"price": _number(fields[9 + i * 2]), "volume": _number(fields[10 + i * 2])} for i in range(5)]
    asks = [{"price": _number(fields[19 + i * 2]), "volume": _number(fields[20 + i * 2])} for i in range(5)]
    return {"symbol": code, "name": fields[1], "price": _number(fields[3]),
            "previous_close": _number(fields[4]), "open": _number(fields[5]),
            "pct": _number(fields[32]) if len(fields) > 32 else 0,
            "bid_total_volume": _number(fields[7]), "ask_total_volume": _number(fields[8]),
            "bids": bids, "asks": asks, "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": "腾讯公开五档盘口（非QMT）", "notice": "公开五档为快照，不是交易所逐笔委托；仅供研究展示。"}


def index_snapshot() -> dict:
    """Return the four core A-share index quotes from Tencent's public feed."""
    targets = [("sh000001", "上证指数"), ("sz399001", "深证成指"),
               ("sz399006", "创业板指"), ("sh000688", "科创综指")]
    try:
        response = httpx.get(TENCENT_QUOTE_URL + ",".join(code for code, _ in targets), headers=HEADERS, timeout=12.0, follow_redirects=True)
        response.raise_for_status(); response.encoding = "gbk"
    except httpx.HTTPError as exc:
        raise MarketDataError("公开指数行情暂时不可用") from exc
    names = dict(targets); rows = []
    for line in response.text.split(";"):
        if '="' not in line: continue
        fields = line.split('="', 1)[1].rstrip('"\r\n').split("~")
        if len(fields) < 33: continue
        code = fields[2]; raw = line.split("_", 1)[0].lstrip("v") if "_" in line else ""
        rows.append({"symbol": code, "name": names.get(raw, fields[1]), "price": _number(fields[3]),
                     "change": _number(fields[31]), "pct": _number(fields[32])})
    if not rows: raise MarketDataError("公开指数行情没有返回数据")
    return {"items": rows, "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "source": "腾讯公开指数行情（非QMT）"}


def all_a_share_symbols() -> list[str]:
    """Cache the listed-share universe; live quote refreshes do not need to redownload it."""
    global _universe_cache
    with _cache_lock:
        if time.time() - _universe_cache[0] < 6 * 60 * 60 and _universe_cache[1]:
            return list(_universe_cache[1])
    symbols = sorted({str(row.get("f12")) for row in all_a_share_spots() if str(row.get("f12") or "").isdigit()})
    with _cache_lock:
        _universe_cache = (time.time(), symbols)
    return list(symbols)


def market_sentiment(force: bool = False, scope: str = "all") -> dict:
    """Compute an A-share breadth snapshot and label its live/closed phase."""
    if scope not in {"all", "hs", "hs_no_st"}:
        raise ValueError("市场口径仅支持 all、hs、hs_no_st")
    symbols = all_a_share_symbols()
    quotes = quote_symbols(symbols)
    selected_symbols = [code for code in symbols if scope == "all" or not code.startswith(("4", "8", "9"))]
    selected_quotes = [quotes[code] for code in selected_symbols if code in quotes]
    if scope == "hs_no_st":
        selected_quotes = [item for item in selected_quotes if "ST" not in str(item.get("name") or "").upper()]
        selected_symbols = [code for code in selected_symbols if code not in quotes or "ST" not in str(quotes[code].get("name") or "").upper()]
    changes = [_number(item.get("pct")) for item in selected_quotes if _number(item.get("price")) > 0]
    if not changes:
        raise MarketDataError("市场情绪行情暂时不可用")
    up = sum(value > 0.01 for value in changes)
    down = sum(value < -0.01 for value in changes)
    flat = len(changes) - up - down
    def limit_rate(item: dict) -> float:
        code, name = str(item.get("symbol") or ""), str(item.get("name") or "").upper()
        if "ST" in name:
            return 5.0
        if code.startswith(("300", "301", "688")):
            return 20.0
        if code.startswith(("4", "8", "9")):
            return 30.0
        return 10.0
    valid_quotes = [item for item in selected_quotes if _number(item.get("price")) > 0]
    limit_up = sum(_number(item.get("pct")) >= limit_rate(item) - .2 for item in valid_quotes)
    limit_down = sum(_number(item.get("pct")) <= -limit_rate(item) + .2 for item in valid_quotes)
    median = statistics.median(changes)
    average = statistics.fmean(changes)
    up_ratio = up / max(1, up + down)
    score = round(max(0, min(100, 50 + (up_ratio - .5) * 70 + median * 8 + (limit_up - limit_down) * .12)))
    label = "亢奋" if score >= 80 else "偏热" if score >= 65 else "均衡" if score >= 45 else "偏冷" if score >= 25 else "冰点"
    ranges = [
        ("≤-7%", lambda x: x <= -7), ("-7~-3%", lambda x: -7 < x <= -3),
        ("-3~0%", lambda x: -3 < x < 0), ("0~3%", lambda x: 0 <= x < 3),
        ("3~7%", lambda x: 3 <= x < 7), ("≥7%", lambda x: x >= 7),
    ]
    distribution = [{"label": label_, "count": sum(test(value) for value in changes)} for label_, test in ranges]
    now_cn = datetime.now(ZoneInfo("Asia/Shanghai"))
    minute = now_cn.hour * 60 + now_cn.minute
    is_live = now_cn.weekday() < 5 and ((9 * 60 + 15) <= minute <= (11 * 60 + 30) or 13 * 60 <= minute <= 15 * 60)
    source = "腾讯公开盘中行情（非QMT）" if is_live else "腾讯公开收盘行情（非QMT）"
    scope_label = {"all": "沪深京全A", "hs": "沪深A", "hs_no_st": "沪深A排除ST"}[scope]
    notice = (f"口径：{scope_label}，剔除无有效价格标的；每60秒刷新。与同花顺自有行情仍可能存在少量差异，QMT接入后可提升为3～5秒增量推送。"
              if is_live else f"口径：{scope_label}，剔除无有效价格标的；当前为最近收盘公开快照。")
    return {"trade_date": now_cn.date().isoformat(), "generated_at": now_cn.strftime("%Y-%m-%d %H:%M:%S"),
            "score": score, "label": label, "total": len(changes), "up": up, "down": down, "flat": flat,
            "limit_up": limit_up, "limit_down": limit_down, "median_pct": round(median, 2),
            "average_pct": round(average, 2), "distribution": distribution,
            "source": source, "is_live": is_live, "refresh_seconds": 60 if is_live else 0,
            "scope": scope, "scope_label": scope_label, "listed_total": len(selected_symbols),
            "excluded_no_price": max(0, len(selected_symbols) - len(changes)),
            "notice": notice}


def sector_stocks(sector: str) -> dict:
    """Return the live public snapshot for all curated stocks in one sector."""
    sector = str(sector or "").strip()
    if not sector:
        raise ValueError("板块名称不能为空")
    reference = next((item for item in SECTOR_REFERENCE if item["sector"] == sector), None)
    if not reference:
        raise ValueError("板块不在项目资料库中")
    names = list(dict.fromkeys([*reference["anchors"], *reference["watch"]]))

    def resolve(name: str) -> tuple[str, str]:
        cached = _symbol_lookup_cache.get(name)
        if cached:
            return name, cached
        try:
            response = httpx.get(EASTMONEY_SUGGEST_URL, params={
                "input": name, "type": 14, "token": "D43BF722C8E33BDC906FB84D85E326E8",
            }, headers=HEADERS, timeout=8.0, follow_redirects=True)
            response.raise_for_status()
            rows = ((response.json().get("QuotationCodeTable") or {}).get("Data") or [])
            exact = next((row for row in rows if row.get("Name") == name and row.get("Classify") == "AStock"), None)
            code = str((exact or {}).get("Code") or "")
            if code:
                _symbol_lookup_cache[name] = code
            return name, code
        except (httpx.HTTPError, ValueError):
            return name, ""

    with ThreadPoolExecutor(max_workers=12) as pool:
        resolved = dict(pool.map(resolve, names))
    symbols = []
    for name in names:
        code = resolved.get(name, "")
        if code:
            prefix = "sh" if code.startswith(("5", "6")) else "bj" if code.startswith(("4", "8", "9")) else "sz"
            symbols.append(prefix + code)
    quotes: dict[str, list[str]] = {}
    try:
        response = httpx.get(TENCENT_QUOTE_URL + ",".join(symbols), headers=HEADERS, timeout=12.0, follow_redirects=True)
        response.raise_for_status()
        for line in response.text.split(";"):
            if '="' not in line:
                continue
            fields = line.split('="', 1)[1].rstrip('"\r\n').split("~")
            if len(fields) > 49 and fields[2]:
                quotes[fields[2]] = fields
    except httpx.HTTPError as exc:
        raise MarketDataError("板块实时行情暂时不可用") from exc
    items = []
    for name in names:
        code = resolved.get(name, "")
        fields = quotes.get(code)
        if not code or not fields:
            continue
        items.append({
            "symbol": code, "name": name, "sector": sector, "price": _number(fields[3]),
            "pct": _number(fields[32]), "turnover": _number(fields[38]),
            "volume_ratio": _number(fields[49]), "market_cap_yi": round(_number(fields[44]), 2),
        })
    items.sort(key=lambda item: item["market_cap_yi"], reverse=True)
    return {"sector": sector, "count": len(items), "items": items,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "source": "公开行情（非QMT）"}


def _sina_daily_kline(symbol: str, limit: int, float_shares: float = 0) -> dict:
    prefix = "sh" if symbol.startswith(("5", "6")) else "bj" if symbol.startswith(("4", "8", "9")) else "sz"
    try:
        response = httpx.get(SINA_KLINE_URL, params={"symbol": prefix + symbol, "scale": 240, "ma": "no", "datalen": limit}, headers=HEADERS, timeout=15.0, follow_redirects=True)
        response.raise_for_status()
        text = response.text
        start, end = text.find("(["), text.rfind("])")
        raw_rows = json.loads(text[start + 1:end + 1]) if start >= 0 and end > start else []
    except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
        raise MarketDataError("日线行情暂时不可用") from exc
    bars, previous = [], 0.0
    for row in raw_rows:
        close, volume = _number(row.get("close")), _number(row.get("volume"))
        pct = (close / previous - 1) * 100 if previous > 0 else 0
        bars.append({
            "date": row.get("day", ""), "open": _number(row.get("open")), "close": close,
            "high": _number(row.get("high")), "low": _number(row.get("low")), "volume": volume,
            "amount": 0, "pct": pct, "turnover": volume / float_shares * 100 if float_shares > 0 else 0,
        })
        previous = close
    return {"symbol": symbol, "name": symbol, "bars": bars[-limit:]}


def _akshare_daily_kline(symbol: str, limit: int) -> dict:
    """Historical daily bars from AKShare's Sina-backed A-share adapter."""
    cache_limit = max(180, limit)
    cache_file = HISTORY_CACHE_DIR / f"{symbol}.json"
    try:
        if cache_file.exists() and time.time() - cache_file.stat().st_mtime < HISTORY_CACHE_SECONDS:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if len(cached.get("bars") or []) >= limit:
                cached["bars"] = cached["bars"][-limit:]
                return cached
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    try:
        ak = _get_akshare()
        prefix = "sh" if symbol.startswith(("5", "6")) else "bj" if symbol.startswith(("4", "8", "9")) else "sz"
        start = (date.today() - timedelta(days=max(400, cache_limit * 3))).strftime("%Y%m%d")
        end = date.today().strftime("%Y%m%d")
        frame = ak.stock_zh_a_daily(symbol=prefix + symbol, start_date=start, end_date=end, adjust="")
    except Exception as exc:
        raise MarketDataError("AKShare 历史行情读取失败") from exc
    bars = []
    previous = 0.0
    for row in frame.to_dict("records"):
        close = _number(row.get("close"))
        pct = (close / previous - 1) * 100 if previous > 0 else 0
        bars.append({
            "date": str(row.get("date", "")), "open": _number(row.get("open")),
            "close": close, "high": _number(row.get("high")), "low": _number(row.get("low")),
            "volume": _number(row.get("volume")), "amount": _number(row.get("amount")),
            "pct": pct, "turnover": _number(row.get("turnover")) * 100,
            "outstanding_share": _number(row.get("outstanding_share")),
        })
        previous = close
    payload = {"symbol": symbol, "name": symbol, "bars": bars[-cache_limit:]}
    try:
        HISTORY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except OSError:
        pass
    return {**payload, "bars": payload["bars"][-limit:]}


def _moving_average(bars: list[dict], days: int) -> float:
    sample = bars[-days:]
    return sum(item["close"] for item in sample) / len(sample) if len(sample) == days else 0.0


def _event_pattern(bar: dict, previous_close: float) -> str | None:
    """Classify the four course-defined abnormal-fund footprints."""
    if previous_close <= 0:
        return None
    pct = (bar["close"] / previous_close - 1) * 100
    open_gap = (bar["open"] / previous_close - 1) * 100
    high_pct = (bar["high"] / previous_close - 1) * 100
    day_range = max(bar["high"] - bar["low"], previous_close * 0.001)
    upper_shadow_ratio = (bar["high"] - max(bar["open"], bar["close"])) / day_range
    if pct >= 9.5:
        return "底部涨停"
    if high_pct >= 9.5 and pct < 8:
        return "涨停炸板"
    if open_gap >= 3 and bar["close"] < bar["open"]:
        return "高开低走"
    if high_pct >= 3 and upper_shadow_ratio >= 0.35:
        return "冲高回落"
    if abs(pct) >= 2 or (bar["high"] / max(bar["low"], 0.01) - 1) * 100 >= 3:
        return "放量异动"
    return None


def _analyse_candidate(
    row: dict,
    baseline_days: int,
    recent_days: int,
    max_turnover: float,
    volume_multiple: float,
    max_cap_yi: float,
    min_decline_pct: float = 8.0,
    max_volume_cv: float = 0.65,
    ma_tolerance_pct: float = 3.0,
    exclude_st: bool = True,
) -> dict | None:
    symbol = str(row.get("f12") or "")
    name = str(row.get("f14") or "")
    if exclude_st and ("ST" in name.upper() or "退" in name):
        return None
    requested = baseline_days + recent_days + 55
    history = _akshare_daily_kline(symbol, requested)
    bars = history["bars"]
    if len(bars) < baseline_days + recent_days:
        return None
    recent = bars[-recent_days:]
    baseline = bars[-(baseline_days + recent_days):-recent_days]
    volume_base = baseline[-20:] if len(baseline) >= 20 else baseline
    avg_turnover = sum(x["turnover"] for x in baseline) / len(baseline)
    highest_turnover = max(x["turnover"] for x in baseline)
    base_volumes = [x["volume"] for x in volume_base if x["volume"] > 0]
    base_volume = statistics.median(base_volumes) if base_volumes else 0
    volume_cv = statistics.pstdev(base_volumes) / (sum(base_volumes) / len(base_volumes)) if len(base_volumes) > 1 else 0
    peak_close = max(x["close"] for x in baseline)
    pre_price = baseline[-1]["close"]
    decline_pct = (peak_close / pre_price - 1) * 100 if pre_price > 0 else 0
    trend_return_pct = (pre_price / baseline[0]["close"] - 1) * 100 if baseline[0]["close"] > 0 else 0

    event_index, event_multiple, pattern = -1, 0.0, None
    for index, bar in enumerate(recent):
        multiple = bar["volume"] / base_volume if base_volume > 0 else 0
        previous_close = baseline[-1]["close"] if index == 0 else recent[index - 1]["close"]
        candidate_pattern = _event_pattern(bar, previous_close)
        if multiple >= volume_multiple and candidate_pattern and multiple > event_multiple:
            event_index, event_multiple, pattern = index, multiple, candidate_pattern
    current_price = recent[-1]["close"]
    pre_cap_yi = pre_price * baseline[-1]["outstanding_share"] / 100_000_000
    # Beachcomber selection is intentionally only three gates: a long quiet
    # period, every day's turnover below the limit, and pre-event market cap.
    # Decline, abnormal-volume and MA logic are diagnostics after selection.
    if highest_turnover > max_turnover or not (0 < pre_cap_yi < max_cap_yi):
        return None

    has_event = event_index >= 0
    event_bar = recent[event_index] if has_event else max(recent, key=lambda item: item["volume"])
    post_event = recent[event_index + 1:] if has_event else []
    all_bars = baseline + recent
    ma15, ma45 = _moving_average(all_bars, 15), _moving_average(all_bars, 45)
    latest = recent[-1]
    distances = [abs(current_price / ma - 1) * 100 for ma in (ma15, ma45) if ma > 0]
    nearest_ma = "MA15" if ma15 > 0 and (not ma45 or abs(current_price - ma15) <= abs(current_price - ma45)) else "MA45"
    ma_distance = min(distances) if distances else 999
    near_support = ma_distance <= ma_tolerance_pct
    pullback_volume_ratio = latest["volume"] / event_bar["volume"] if event_bar["volume"] > 0 else 1
    candle_range = max(latest["high"] - latest["low"], current_price * 0.001)
    small_candle = abs(latest["close"] - latest["open"]) / candle_range <= 0.45
    pullback_ready = bool(post_event) and near_support and pullback_volume_ratio <= 0.8 and small_candle
    if not has_event:
        entry_status = "尚未异动"
    elif pullback_ready:
        entry_status = "回踩观察"
    elif not post_event:
        entry_status = "等待回踩"
    elif near_support:
        entry_status = "均线附近"
    else:
        entry_status = "持续跟踪"

    score = 20
    score += min(15, decline_pct / max(min_decline_pct, 1) * 8)
    score += max(0, 15 * (1 - volume_cv / max(max_volume_cv, 0.01)))
    score += min(20, event_multiple / max(volume_multiple, 0.1) * 10) if has_event else 0
    score += 10 if pattern in {"底部涨停", "涨停炸板", "冲高回落", "高开低走"} else 6 if has_event else 0
    score += 12 if near_support else max(0, 8 - ma_distance)
    score += 5 if pullback_volume_ratio <= 0.8 else 0
    score += 3 if small_candle else 0
    score = min(100, round(score))
    priority = "A" if pullback_ready and score >= 75 else "B" if has_event and score >= 68 else "C"
    return {
        "symbol": symbol, "name": name or history["name"], "sector": sector_for_name(name), "price": current_price,
        "pct": round(recent[-1]["pct"], 2), "avg_turnover": round(avg_turnover, 2),
        "max_turnover": round(highest_turnover, 2),
        "recent_turnover": round(sum(x["turnover"] for x in recent) / len(recent), 2),
        "volume_multiple": round(event_multiple, 2), "pre_market_cap_yi": round(pre_cap_yi, 2),
        "decline_pct": round(decline_pct, 1), "volume_cv": round(volume_cv, 2),
        "pattern": pattern or "尚未异动", "event_date": event_bar["date"] if has_event else "", "days_since_event": len(post_event),
        "ma15": round(ma15, 2), "ma45": round(ma45, 2), "nearest_ma": nearest_ma,
        "ma_distance_pct": round(ma_distance, 1), "pullback_volume_ratio": round(pullback_volume_ratio, 2),
        "entry_status": entry_status, "score": score, "priority": priority,
        "latest_date": latest["date"],
    }


def scan_low_turnover_volume_breakout(*, max_market_cap_yi: float = 100, max_avg_turnover: float = 1.5, recent_days: int = 5, volume_multiple: float = 2.0, baseline_days: int = 60, min_decline_pct: float = 8.0, max_volume_cv: float = 0.65, ma_tolerance_pct: float = 3.0, exclude_st: bool = True, force: bool = False) -> dict:
    key = (max_market_cap_yi, max_avg_turnover, recent_days, volume_multiple, baseline_days, min_decline_pct, max_volume_cv, ma_tolerance_pct, exclude_st)
    with _cache_lock:
        cached = _scan_cache.get(key)
        if not force and cached and time.time() - cached[0] < 600:
            return cached[1]
    # Every listed A share enters historical review. Market-cap and volume
    # conditions are evaluated at the pre-breakout date, not from today's quote.
    spots = _all_sina_spots(enrich=False)
    candidates = spots
    matches, failures = [], 0
    # MiniRacer used by this AKShare adapter is not thread-safe on Windows.
    # Separate worker processes isolate its native V8 state safely.
    with ProcessPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(_analyse_candidate, row, baseline_days, recent_days, max_avg_turnover, volume_multiple, max_market_cap_yi, min_decline_pct, max_volume_cv, ma_tolerance_pct, exclude_st) for row in candidates]
        for future in as_completed(futures):
            try:
                item = future.result()
                if item:
                    matches.append(item)
            except (MarketDataError, ValueError):
                failures += 1
    matches.sort(key=lambda x: (-x["score"], -x["volume_multiple"], x["symbol"]))
    stage_counts = {stage: sum(1 for item in matches if item["entry_status"] == stage) for stage in ("回踩观察", "等待回踩", "均线附近", "持续跟踪", "尚未异动")}
    sector_counts: dict[str, int] = {}
    for item in matches:
        sector_counts[item["sector"]] = sector_counts.get(item["sector"], 0) + 1
    result = {
        "count": len(matches), "items": matches, "universe_count": len(spots),
        "prefilter_count": len(candidates) - failures, "failed_count": failures,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stage_counts": stage_counts, "sector_counts": sector_counts,
        "criteria": {"baseline_days": baseline_days, "max_avg_turnover": max_avg_turnover, "recent_days": recent_days, "volume_multiple": volume_multiple, "max_market_cap_yi": max_market_cap_yi, "min_decline_pct": min_decline_pct, "max_volume_cv": max_volume_cv, "ma_tolerance_pct": ma_tolerance_pct, "exclude_st": exclude_st},
        "data_source": "AKShare / 新浪历史行情（只读，非交易接口）",
    }
    with _cache_lock:
        _scan_cache[key] = (time.time(), result)
    return result
