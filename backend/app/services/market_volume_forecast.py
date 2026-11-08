"""全市场真实分钟成交额聚合与预测的纯函数。"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from app.services.volume_forecast import forecast_amount


def _stamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="minutes")
    return str(value or "").strip()[:16]


def aggregate_amount_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sum real stock-minute amounts by timestamp; never infer amount."""
    totals: defaultdict[str, float] = defaultdict(float)
    for row in rows:
        stamp = _stamp(row.get("datetime") or row.get("time"))
        try:
            amount = float(row.get("amount"))
        except (TypeError, ValueError):
            continue
        if stamp and amount >= 0:
            totals[stamp] += amount
    return [{"datetime": stamp, "amount": round(totals[stamp], 2)}
            for stamp in sorted(totals)]


def forecast_market_amount(current_rows: list[dict[str, Any]],
                           historical_days: list[list[dict[str, Any]]],
                           *, source: str = "未声明分钟数据源") -> dict[str, Any]:
    """Forecast full-market turnover from aggregated real minute amounts."""
    return forecast_amount(aggregate_amount_rows(current_rows),
                           [aggregate_amount_rows(rows) for rows in historical_days],
                           source=source)
