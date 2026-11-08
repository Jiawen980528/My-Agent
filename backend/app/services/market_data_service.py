"""统一的 MyAgent 行情服务。

这个服务只负责只读行情与统一元数据，不负责账户、委托或交易。
所有返回值都带有 source/market_time/received_at/stale，前端不得把缓存
数据当作实时数据使用。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.tickflow.capabilities import CapabilitySet

CN_TZ = ZoneInfo("Asia/Shanghai")


def _get_client():
    from app.tickflow.client import get_client
    return get_client()


def normalize_symbol(value: str) -> str:
    """Normalize common Shanghai suffix spelling without guessing exchanges."""
    symbol = str(value or "").strip().upper()
    return symbol.replace(".SS", ".SH")


def _parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000
        return datetime.fromtimestamp(number, tz=timezone.utc).astimezone(CN_TZ)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=CN_TZ)
    return parsed.astimezone(CN_TZ)


def freshness(market_time: Any, *, received_at: datetime | None = None,
              stale_after_seconds: int = 90) -> dict[str, Any]:
    received = received_at or datetime.now(CN_TZ)
    market = _parse_timestamp(market_time)
    age = None if market is None else max(0, int((received - market).total_seconds()))
    return {
        "market_time": market.isoformat(timespec="seconds") if market else None,
        "received_at": received.isoformat(timespec="seconds"),
        "age_seconds": age,
        "stale": market is None or age > stale_after_seconds,
    }


def quote_snapshot(symbols: list[str]) -> dict[str, Any]:
    requested = list(dict.fromkeys(normalize_symbol(item) for item in symbols if str(item).strip()))
    received = datetime.now(CN_TZ)
    if not requested:
        return {"source": "TickFlow", "items": [], "missing_symbols": [], "complete": True,
                **freshness(None, received_at=received)}
    rows = _get_client().quotes.get(symbols=requested) or []
    items = []
    for row in rows:
        ext = row.get("ext") or {}
        item = {
            "source": "TickFlow",
            "symbol": normalize_symbol(row.get("symbol")),
            "name": ext.get("name"),
            "price": row.get("last_price"),
            "prev_close": row.get("prev_close"),
            "high": row.get("high"),
            "low": row.get("low"),
            "amount": row.get("amount"),
            "volume": row.get("volume"),
            "timestamp": row.get("timestamp"),
        }
        item.update(freshness(row.get("timestamp"), received_at=received))
        items.append(item)
    latest = next((item["market_time"] for item in reversed(items) if item["market_time"]), None)
    status = freshness(latest, received_at=received)
    returned = {str(item.get("symbol") or "") for item in items}
    missing = [symbol for symbol in requested if symbol not in returned]
    return {"source": "TickFlow", "items": items, "missing_symbols": missing,
            "complete": not missing, **status}


def minute_quality(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize ordering/duplicate quality without fabricating or repairing bars."""
    timestamps = [str(item.get("datetime") or "") for item in items]
    unique_timestamps = set(timestamps)
    return {
        "row_count": len(items),
        "duplicate_timestamps": len(timestamps) - len(unique_timestamps),
        "sorted": timestamps == sorted(timestamps),
        "timezone": "Asia/Shanghai",
        "valid": len(timestamps) == len(unique_timestamps) and timestamps == sorted(timestamps),
    }


def minute_bars(symbol: str, trade_date: date, *, capset: CapabilitySet,
                asset_type: str = "stock") -> dict[str, Any]:
    normalized = normalize_symbol(symbol)
    from app.tickflow.capabilities import Cap
    if not capset.has(Cap.KLINE_MINUTE_BY_SYMBOL):
        raise PermissionError("minute entitlement unavailable")
    from app.services.kline_sync import fetch_minute_single
    bars = fetch_minute_single(normalized, trade_date, asset_type=asset_type, capset=capset)
    items = [{**row, "datetime": str(row["datetime"]), "source": "TickFlow"} for row in bars.to_dicts()]
    quality = minute_quality(items)
    latest = items[-1]["datetime"] if items else None
    return {
        "symbol": normalized,
        "trade_date": trade_date.isoformat(),
        "source": "TickFlow",
        "rows": items,
        "quality": quality,
        "last_market_time": latest,
        **freshness(latest),
    }
