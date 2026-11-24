"""成交额预测的可核验复盘记录。

只保存预测快照与真实结果，不把缺失数据当作成功率分母，也不生成虚构的
实际成交额。文件落在 user_data 下，不修改现有账户、持仓和交易数据库。
"""
from __future__ import annotations

from typing import Any

from app.services.json_report_store import JsonReportStore

_store = JsonReportStore("forecast_reviews.json", 200, id_prefix="fvr", id_with_symbol=False)


def classify_prediction(actual_amount: float | None, forecast_low: float | None,
                        forecast_high: float | None) -> str:
    """严格分类：缺少真实值/区间时保持 pending，不猜测。"""
    if actual_amount is None or forecast_low is None or forecast_high is None:
        return "pending"
    return "hit" if float(forecast_low) <= float(actual_amount) <= float(forecast_high) else "miss"


def save_prediction(payload: dict[str, Any]) -> dict[str, Any]:
    return _store.save_report({"status": "pending", **payload})


def list_reviews() -> list[dict[str, Any]]:
    return _store.list_reports()


def resolve_review(review_id: str, actual_amount: float, *, note: str = "") -> dict[str, Any] | None:
    rows = _store.list_reports()
    target = next((row for row in rows if row.get("id") == review_id), None)
    if target is None:
        return None
    low = target.get("forecast_low")
    high = target.get("forecast_high")
    status = classify_prediction(actual_amount, low if isinstance(low, (int, float)) else None,
                                 high if isinstance(high, (int, float)) else None)
    target.update({
        "status": status,
        "actual_amount": round(actual_amount, 2),
        "resolved_note": note,
        "error_pct": round((actual_amount - float(target.get("forecast_amount"))) / actual_amount * 100, 4)
        if actual_amount and isinstance(target.get("forecast_amount"), (int, float)) else None,
    })
    # JsonReportStore 没有原地更新接口，使用原子保存前先删除旧记录，再写入同一条。
    _store.delete_report(review_id)
    return _store.save_report(target)


def summary() -> dict[str, Any]:
    rows = list_reviews()
    resolved = [row for row in rows if row.get("status") in {"hit", "miss"}]
    hits = sum(row.get("status") == "hit" for row in resolved)
    return {
        "total": len(rows),
        "resolved": len(resolved),
        "pending": len(rows) - len(resolved),
        "hits": hits,
        "misses": len(resolved) - hits,
        "success_rate": round(hits / len(resolved) * 100, 2) if resolved else None,
        "definition": "真实收盘值落在预测区间内才算命中；待复盘不计入分母",
    }
