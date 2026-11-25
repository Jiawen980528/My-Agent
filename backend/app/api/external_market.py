"""只读外部市场上下文。

这里的美股数据只用于解释 A 股开盘前后的外围影响，不参与 TickFlow 行情、
板块资金流或交易信号计算。上游不可用时返回明确的 unavailable 状态，绝不补零。
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from threading import Lock

import httpx
from fastapi import APIRouter

router = APIRouter(prefix="/api/external-market", tags=["external-market"])

_SYMBOLS = (
    ("^GSPC", "标普500"),
    ("^IXIC", "纳斯达克"),
    ("^DJI", "道琼斯"),
    ("^VIX", "VIX恐慌指数"),
)
_CACHE: dict[str, object] | None = None
_CACHE_AT = 0.0
_LOCK = Lock()
_TTL_SECONDS = 60.0


def _parse_quote(symbol: str, name: str, payload: dict) -> dict:
    chart = payload.get("chart") or {}
    result = (chart.get("result") or [None])[0] or {}
    meta = result.get("meta") or {}
    quote = ((result.get("indicators") or {}).get("quote") or [None])[0] or {}
    timestamps = result.get("timestamp") or []
    closes = quote.get("close") or []
    values = [(ts, close) for ts, close in zip(timestamps, closes) if close is not None]
    last = float(meta["regularMarketPrice"]) if meta.get("regularMarketPrice") is not None else (float(values[-1][1]) if values else None)
    previous = meta.get("previousClose")
    if previous is None and len(values) >= 2:
        previous = values[-2][1]
    previous = float(previous) if previous is not None else None
    change_pct = ((last - previous) / previous * 100) if last is not None and previous else None
    as_of = None
    if values:
        as_of = datetime.fromtimestamp(values[-1][0], tz=timezone.utc).isoformat()
    return {
        "symbol": symbol,
        "name": name,
        "last": last,
        "previous_close": previous,
        "change_pct": change_pct,
        "as_of": as_of,
        "status": "ok" if last is not None else "unavailable",
    }


def _fetch() -> dict:
    generated_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    errors: list[str] = []
    started = time.monotonic()
    url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    def fetch_one(symbol: str, name: str) -> dict:
        one = httpx.get(f"{url}{symbol}", params={"range": "5d", "interval": "1d"}, timeout=8.0, headers={"User-Agent": "MyAgent/1.0"})
        one.raise_for_status()
        return _parse_quote(symbol, name, one.json())

    # 并行请求，任何单个公共源失败都不影响其它标的返回；总等待时间由单项超时控制。
    with ThreadPoolExecutor(max_workers=len(_SYMBOLS), thread_name_prefix="external-market") as pool:
        futures = {pool.submit(fetch_one, symbol, name): symbol for symbol, name in _SYMBOLS}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                rows.append(future.result())
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{symbol}: {type(exc).__name__}")
    rows.sort(key=lambda row: next(i for i, (symbol, _) in enumerate(_SYMBOLS) if symbol == row["symbol"]))
    return {
        "status": "ok" if any(row["status"] == "ok" for row in rows) else "unavailable",
        "rows": rows,
        "source": "Yahoo Finance chart 公共行情（可能延迟）",
        "generated_at": generated_at,
        "latency_ms": round((time.monotonic() - started) * 1000),
        "errors": errors,
        "notice": "仅作外围市场背景参考，不替代 TickFlow A 股行情、资金流或交易信号。",
    }


@router.get("/context")
def external_market_context() -> dict:
    global _CACHE, _CACHE_AT
    with _LOCK:
        now = time.monotonic()
        if _CACHE is not None and now - _CACHE_AT < _TTL_SECONDS:
            return {**_CACHE, "cached": True}
        data = _fetch()
        _CACHE = data
        _CACHE_AT = now
        return {**data, "cached": False}

