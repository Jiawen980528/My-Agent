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

    breadth = snapshot.get("market_breadth") if isinstance(snapshot.get("market_breadth"), dict) else {}
    turnover = snapshot.get("turnover_forecast") if isinstance(snapshot.get("turnover_forecast"), dict) else {}
    defensive = snapshot.get("defensive") if isinstance(snapshot.get("defensive"), dict) else {}
    multi_period = snapshot.get("multi_period") if isinstance(snapshot.get("multi_period"), dict) else {}
    trades_today = snapshot.get("trades_today") if isinstance(snapshot.get("trades_today"), list) else []
    period_keys = ("daily", "minute_60", "minute_15", "minute_5")
    period_ready = all(
        isinstance(multi_period.get(key), dict)
        and int(_num(multi_period[key].get("observations")) or 0) >= 2
        for key in period_keys
    )
    context_missing = [key for key, value in (("market_breadth", breadth), ("turnover_forecast", turnover),
                                               ("defensive", defensive)) if not value]
    if not period_ready:
        context_missing.append("multi_period")
    if snapshot.get("strict_context") is True and context_missing:
        reasons.append("缺少决策上下文：" + ", ".join(context_missing))

    action = "WAIT"
    rating = "不可评估" if reasons else "观察"
    trigger = None
    invalidation = None
    max_loss = 0.0
    max_qty = 0
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
            available_cash = _num(account.get("available_cash"))
            if available_cash is not None and price > 0:
                max_qty = min(max_qty, int(available_cash / price))
            used_risk = _num(account.get("day_risk_used")) or 0.0
            max_qty = min(max_qty, int(max(0.0, budget - used_risk) / risk_per_share)) if risk_per_share > 0 else 0
            max_loss = round(max_qty * risk_per_share, 2)
            basis.extend(["个股价格/支撑/压力", "大盘涨跌", "关联板块涨跌", "账户风险预算"])
            if period_ready:
                basis.append("日线/60分钟/15分钟/5分钟多周期")
                daily = multi_period.get("daily") if isinstance(multi_period.get("daily"), dict) else {}
                hour = multi_period.get("minute_60") if isinstance(multi_period.get("minute_60"), dict) else {}
                short = multi_period.get("minute_15") if isinstance(multi_period.get("minute_15"), dict) else {}
                daily_trend = str(daily.get("trend") or "")
                hour_trend = str(hour.get("trend") or "")
                short_trend = str(short.get("trend") or "")
                if daily_trend == "down" and hour_trend == "down":
                    reasons.append("日线与60分钟趋势同步偏弱")
                elif daily_trend == "up" and hour_trend == "up" and short_trend == "up":
                    basis.append("多周期趋势同步偏强")
                else:
                    basis.append("多周期趋势存在分歧")
            if breadth:
                up = _num(breadth.get("up_count"))
                down = _num(breadth.get("down_count"))
                basis.append("市场广度")
                if up is not None and down is not None and down > up:
                    reasons.append("市场下跌家数多于上涨家数")
            if turnover:
                basis.append("全市场真实成交额预测")
                if turnover.get("status") != "ok":
                    reasons.append("全市场成交额预测不可用")
            if defensive:
                defensive_pct = _num(defensive.get("pct"))
                basis.append("防守板块相对强弱")
                if defensive_pct is not None and market_pct is not None and defensive_pct > market_pct + 1:
                    reasons.append("防守板块明显强于大盘，风险偏好偏弱")
            if trades_today:
                basis.append("当日已成交记录")
            if reasons:
                action, rating = "WAIT", "等待上下文"
                max_qty = 0
                max_loss = 0.0
            elif market_pct is None or board_pct is None or volume_ratio is None:
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
        "evidence": {
            "market_breadth": breadth or None,
            "turnover_forecast": turnover or None,
            "defensive": defensive or None,
            "multi_period": multi_period or None,
            "trades_today_count": len(trades_today),
            "context_missing": context_missing,
        },
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
