"""可审计的量化操作辅助规则。

这是决策辅助，不是自动交易策略。它只消费调用方提供的真实快照；任何
数据缺失或过期都会 fail-closed 为 WAIT，并把原因返回给前端。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

CN_TZ = ZoneInfo("Asia/Shanghai")


def _num(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def build_decision(snapshot: dict[str, Any], *, risk_budget: float = 5000.0,
                   now: datetime | None = None) -> dict[str, Any]:
    generated = now or datetime.now(CN_TZ)
    reasons: list[str] = []
    missing: list[str] = []
    for key in ("quote", "market", "board", "account"):
        if not isinstance(snapshot.get(key), dict):
            missing.append(key)
    if missing:
        reasons.append("缺少真实数据：" + ", ".join(missing))

    freshness = snapshot.get("freshness") or {}
    if freshness.get("stale") is True:
        reasons.append("行情已过期，禁止生成新操作信号")
    if freshness.get("market_time") is None:
        reasons.append("没有可核验的行情时间")
    budget = max(0.0, _num(risk_budget) or 0.0)
    if budget <= 0:
        reasons.append("风险预算为零")
    account = snapshot.get("account") if isinstance(snapshot.get("account"), dict) else {}
    account_source = str(account.get("source") or "unknown")
    account_verified = account.get("verified") is True and account_source in {"qmt", "ptrade", "broker_realtime"}
    if not account_verified:
        reasons.append(f"账户数据来源为 {account_source}，未核验为券商实时账户")

    action = "WAIT"
    rating = "不可评估" if reasons else "观察"
    trigger = None
    invalidation = None
    max_loss = 0.0
    basis: list[str] = []
    if not reasons:
        quote = snapshot["quote"]
        market = snapshot["market"]
        board = snapshot["board"]
        price = _num(quote.get("price"))
        support = _num(quote.get("support"))
        resistance = _num(quote.get("resistance"))
        market_pct = _num(market.get("pct"))
        board_pct = _num(board.get("pct"))
        volume_ratio = _num(market.get("turnover_ratio"))
        if price is None or support is None or resistance is None:
            reasons.append("缺少价格、支撑位或压力位，不能计算触发条件")
        else:
            trigger = round(max(support, 0.0), 4)
            invalidation = round(max(support * 0.99, 0.0), 4)
            risk_per_share = max(price - invalidation, 0.0)
            max_qty = int(budget / risk_per_share) if risk_per_share > 0 else 0
            max_loss = round(max_qty * risk_per_share, 2)
            basis.extend(["个股价格/支撑/压力", "大盘涨跌", "关联板块涨跌", "账户风险预算"])
            if market_pct is None or board_pct is None or volume_ratio is None:
                reasons.append("市场广度、板块或成交额预测数据不完整")
            elif market_pct < 0 and board_pct < 0:
                action, rating = "WAIT", "偏弱，等待"
                reasons.append("大盘与关联板块同步偏弱")
            elif price <= support * 1.01 and board_pct >= 0 and market_pct >= 0 and max_qty > 0:
                action, rating = "CONDITIONAL_ADD", "条件观察"
                reasons.append("仅在接近支撑且大盘、板块同时转强时观察")
            else:
                action, rating = "HOLD", "持有/观察"
                reasons.append("尚未同时满足条件加仓触发条件")

    expires = generated + timedelta(minutes=15)
    return {
        "action": action,
        "rating": rating,
        "reasons": reasons,
        "basis": basis,
        "trigger_price": trigger,
        "invalidation_price": invalidation,
        "suggested_qty": 0 if action != "CONDITIONAL_ADD" else max_qty,
        "max_risk_yuan": max_loss if action == "CONDITIONAL_ADD" else 0.0,
        "risk_budget_yuan": round(budget, 2),
        "account_source": account_source,
        "account_verified": account_verified,
        "generated_at": generated.isoformat(timespec="seconds"),
        "valid_until": expires.isoformat(timespec="seconds"),
        "status": "WAIT" if reasons and action == "WAIT" else "OK",
        "disclaimer": "仅为条件式决策辅助，不自动下单；任何过期数据都必须重新计算。",
    }
