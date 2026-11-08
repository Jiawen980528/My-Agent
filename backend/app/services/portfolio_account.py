"""只读账户快照契约。

行情数据和券商账户数据是两条不同的信任链。这里不连接券商、不接收密码，
只负责规范化已授权适配器提供的快照；没有适配器时必须显式返回 unavailable，
不能把手工/CSV 数据标成实时账户。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

CN_TZ = ZoneInfo("Asia/Shanghai")
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ|SS)$")
_TRUSTED_SOURCES = {"qmt", "ptrade", "broker_realtime"}


def _canonical_symbol(value: Any) -> str | None:
    symbol = str(value or "").strip().upper().replace(".SS", ".SH")
    return symbol if _SYMBOL.fullmatch(symbol) else None


def unavailable(reason: str, *, source: str = "unavailable") -> dict[str, Any]:
    """Return a UI-safe account status with no invented balance or positions."""
    return {
        "status": "unavailable",
        "source": source,
        "verified": False,
        "synced_at": None,
        "reason": reason,
        "total_assets": None,
        "position_value": None,
        "cash_available": None,
        "day_pnl": None,
        "cumulative_pnl": None,
        "position_ratio": None,
        "items": [],
    }


def normalize_snapshot(payload: Any, *, source: str, verified: bool) -> dict[str, Any]:
    """Normalize an adapter snapshot and preserve its provenance.

    ``verified`` is controlled by the adapter, never inferred from a browser
    request. Manual and CSV sources are deliberately forced to unverified.
    """
    if not isinstance(payload, dict):
        return unavailable("账户适配器未返回对象", source=source or "unknown")
    source_name = str(source or payload.get("source") or "unknown").strip().lower()
    trusted = bool(verified and source_name in _TRUSTED_SOURCES)
    items: list[dict[str, Any]] = []
    raw_items = payload.get("items")
    if isinstance(raw_items, list):
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            symbol = _canonical_symbol(raw.get("symbol"))
            if not symbol:
                continue
            items.append({
                "symbol": symbol,
                "name": str(raw.get("name") or symbol),
                "quantity": raw.get("quantity"),
                "available_quantity": raw.get("available_quantity"),
                "cost": raw.get("cost"),
                "source": source_name,
            })
    synced_at = payload.get("synced_at")
    if synced_at is None and trusted:
        synced_at = datetime.now(CN_TZ).isoformat(timespec="seconds")
    return {
        "status": "ok" if trusted else "unverified",
        "source": source_name,
        "verified": trusted,
        "synced_at": synced_at,
        "reason": None if trusted else "账户来源未通过券商实时适配器核验",
        "total_assets": payload.get("total_assets"),
        "position_value": payload.get("position_value"),
        "cash_available": payload.get("cash_available"),
        "day_pnl": payload.get("day_pnl"),
        "cumulative_pnl": payload.get("cumulative_pnl"),
        "position_ratio": payload.get("position_ratio"),
        "items": items,
    }


def is_trusted(snapshot: Any) -> bool:
    return bool(isinstance(snapshot, dict) and snapshot.get("verified") is True
                and snapshot.get("source") in _TRUSTED_SOURCES and snapshot.get("status") == "ok")
