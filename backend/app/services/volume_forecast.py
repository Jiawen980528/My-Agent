"""成交额全天预测 based only on real minute amount samples.

The service deliberately fails closed: without at least three comparable
historical sessions and a non-zero amount field it returns unavailable instead
of extrapolating from price or volume.
"""
from __future__ import annotations

from datetime import datetime
from statistics import median
from typing import Any


def _amount_rows(rows: list[dict[str, Any]]) -> list[tuple[str, float]]:
    out = []
    for row in rows:
        try:
            stamp = str(row.get("datetime") or row.get("time") or "")
            amount = float(row.get("amount"))
        except (TypeError, ValueError):
            continue
        if stamp and amount >= 0:
            out.append((stamp[11:16] if len(stamp) >= 16 else stamp, amount))
    return out


def forecast_amount(current_rows: list[dict[str, Any]], historical_days: list[list[dict[str, Any]]],
                    *, now: datetime | None = None,
                    source: str = "未声明分钟数据源") -> dict[str, Any]:
    current = _amount_rows(current_rows)
    history = [_amount_rows(rows) for rows in historical_days]
    if len(history) < 3 or len(current) < 2:
        return {"status": "unavailable", "reason": "至少需要 3 个可比交易日和当前分钟成交额"}
    current_by_time = dict(current)
    current_total = sum(amount for _time, amount in current)
    latest_time = current[-1][0]
    comparable = []
    for day in history:
        by_time = dict(day)
        total = sum(amount for _time, amount in day)
        if total <= 0 or latest_time not in by_time:
            continue
        historical_cum = sum(amount for stamp, amount in day if stamp <= latest_time)
        if historical_cum > 0:
            comparable.append((total, historical_cum / total))
    if len(comparable) < 3 or current_total <= 0:
        return {"status": "unavailable", "reason": "可比交易日缺少同一时点的有效成交额"}
    ratios = [ratio for _total, ratio in comparable]
    ratio_mid = median(ratios)
    if ratio_mid <= 0:
        return {"status": "unavailable", "reason": "历史成交额进度比例无效"}
    # Estimate the full-day total from current cumulative amount and each
    # historical session's observed cumulative share.
    estimates = [current_total / ratio for ratio in ratios]
    p10 = sorted(estimates)[max(0, int(len(estimates) * 0.1) - 1)]
    p90 = sorted(estimates)[min(len(estimates) - 1, max(0, int(len(estimates) * 0.9)))]
    return {
        "status": "ok",
        "as_of": latest_time,
        "current_cumulative_amount": round(current_total, 2),
        "forecast_amount": round(current_total / ratio_mid, 2),
        "forecast_low": round(p10, 2),
        "forecast_high": round(p90, 2),
        "sample_days": len(comparable),
        "method": "当前累计成交额 / 历史同期累计成交额占全天比例的中位数",
        "source": source,
        "stale": False,
    }
