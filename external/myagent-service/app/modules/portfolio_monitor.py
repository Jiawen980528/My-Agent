"""Read-only board charts and capital flow for the portfolio monitor."""
from __future__ import annotations

import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

# Exact board codes were checked against the upstream public board catalog.
# TickFlow is used only for the two exchange-index links below. TickFlow's
# current project bridge has no dedicated industry/concept-board endpoint, so
# board charts must not be labelled as TickFlow data.
BOARDS = {
    "159558.SZ": ("半导体", "BK1036", "eastmoney"),
    "588080.SH": ("科创50指数", "000688.SH", "tickflow"),
    "159246.SZ": ("人工智能", "BK0800", "eastmoney"),
    "510210.SH": ("上证指数", "000001.SH", "tickflow"),
    "000938.SZ": ("计算机设备", "BK0735", "eastmoney"),
    "515880.SH": ("通信设备", "BK0448", "eastmoney"),
    "600939.SH": ("建筑装饰", "BK1209", "eastmoney"),
}
_cache: dict[str, tuple[float, dict]] = {}
_TREND = "https://push2his.eastmoney.com/api/qt/stock/trends2/get"
_FLOW = "https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get"


def board_meta(symbol: str) -> dict | None:
    entry = BOARDS.get(symbol)
    return {"name": entry[0], "code": entry[1], "source": entry[2]} if entry else None


def get_board(symbol: str, trade_date: str | None = None) -> dict:
    entry = BOARDS.get(symbol)
    if not entry:
        return {"board": None, "rows": [], "flow": [], "status": "关联板块未绑定"}
    name, code, source = entry
    if source == "tickflow":
        from .market import get_tickflow_portfolio
        params = {"symbol": code}
        if trade_date:
            params["trade_date"] = trade_date
        result = get_tickflow_portfolio("portfolio-minute", params)
        return {"board": board_meta(symbol), "rows": result.get("rows", []),
                "flow": [], "flow_status": "指数资金流向数据源未接入",
                "source": result.get("source"),
                "provider": "tickflow" if result.get("source") == "TickFlow Pro" else "fallback",
                "last_market_time": result.get("last_market_time")}
    cache_key = f"{code}:{trade_date or 'latest'}"
    cached = _cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    secid = "90." + code
    with httpx.Client(timeout=10.0) as client:
        trend_response = client.get(_TREND, params={
            "secid": secid, "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "iscr": "0", "ndays": "1"})
        trend_response.raise_for_status()
        trend = trend_response.json().get("data") or {}
        try:
            flow_response = client.get(_FLOW, params={
                "secid": secid, "lmt": "0", "klt": "1", "fields1": "f1,f2,f3,f7",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63",
                "ut": "b2884a393a59ad64002292a3e90d46a5"})
            flow_response.raise_for_status()
            flow_lines = (flow_response.json().get("data") or {}).get("klines") or []
        except (httpx.HTTPError, ValueError):
            flow_lines = []
    latest_day = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    available = (trend.get("trends") or [""])[-1][:10]
    rows = []
    for line in trend.get("trends") or []:
        values = line.split(",")
        if len(values) < 7 or values[0][:10] != available:
            continue
        try:
            rows.append({"datetime": values[0], "open": float(values[1]),
                         "close": float(values[2]), "high": float(values[3]),
                         "low": float(values[4]), "volume": float(values[5]),
                         "amount": float(values[6])})
        except ValueError:
            continue
    flow = []
    for line in flow_lines:
        values = line.split(",")
        if len(values) < 6 or values[0][:10] != available:
            continue
        try:
            flow.append({"datetime": values[0], "main_yi": round(float(values[1])/1e8, 3),
                         "small_yi": round(float(values[2])/1e8, 3),
                         "medium_yi": round(float(values[3])/1e8, 3),
                         "big_yi": round(float(values[4])/1e8, 3),
                         "super_yi": round(float(values[5])/1e8, 3)})
        except ValueError:
            continue
    if trade_date and trade_date != available:
        rows = []
        flow = []
        flow_status = "该日期的公开板块分钟数据不可用；数据源仅返回最近交易日"
    else:
        flow_status = "ok" if flow else "资金流向数据源未接入"
    result = {"board": board_meta(symbol), "rows": rows, "flow": flow,
              "flow_status": flow_status,
              "source": "东方财富公开板块行情（可能延迟）", "provider": "eastmoney",
              "flow_source": "东方财富资金流向（公开口径）" if flow else None,
              "market_date": available, "is_current_day": available == latest_day,
              "last_market_time": rows[-1]["datetime"] if rows else None}
    _cache[cache_key] = (time.monotonic(), result)
    return result
