"""Unverified historical account snapshots and read-only trade journal.

The seed records user-provided 2026-11-06 facts; it never updates live holdings.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from .. import db

MONEY = Decimal("0.01")
FEE_RATE = Decimal("0.0001")
MIN_FEE = Decimal("5.00")
SEED_DAY = "2026-11-06"
SEED_TRADES = (
    ("159558.SZ", "09:34", "sell", 23800, "0.803"),
    ("159558.SZ", "10:55", "buy", 12000, "0.830"),
    ("159558.SZ", "11:17", "buy", 12100, "0.824"),
    ("159558.SZ", "13:57", "buy", 12300, "0.821"),
    ("588080.SH", "09:38", "sell", 10000, "1.273"),
    ("588080.SH", "10:55", "buy", 7600, "1.304"),
    ("588080.SH", "13:40", "buy", 7700, "1.291"),
)
SEED_HOLDINGS = {
    "159558.SZ": 60200, "588080.SH": 25500, "159246.SZ": 9500,
    "510210.SH": 7800, "000938.SZ": 200, "515880.SH": 10500,
    "600939.SH": 1000,
}


def normalize_trade(trade_date: str, trade_time: str, symbol: str, side: str,
                    quantity: int, price: str, *, source: str, external_id: str | None = None) -> dict:
    date.fromisoformat(trade_date)
    datetime.strptime(trade_time, "%H:%M")
    symbol = symbol.upper().replace(".SS", ".SH")
    if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", symbol):
        raise ValueError("证券代码必须包含交易所后缀")
    if side not in {"buy", "sell"} or not isinstance(quantity, int) or not 0 < quantity <= 1_000_000_000:
        raise ValueError("交易方向或数量无效")
    try:
        px = Decimal(str(price))
    except InvalidOperation as exc:
        raise ValueError("交易价格无效") from exc
    if not px.is_finite() or not Decimal("0") < px <= Decimal("1000000"):
        raise ValueError("交易价格无效")
    amount = (px * quantity).quantize(MONEY, rounding=ROUND_HALF_UP)
    fee = max(MIN_FEE, amount * FEE_RATE).quantize(MONEY, rounding=ROUND_HALF_UP)
    # Exact source, time, symbol, side, quantity and price identify an import.
    canonical = f"{source}|{trade_date}|{trade_time}|{symbol}|{side}|{quantity}|{format(px.normalize(), 'f')}|{external_id or ''}"
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    cash = amount - fee if side == "sell" else -amount - fee
    return {"fingerprint": fingerprint, "trade_date": trade_date, "trade_time": trade_time,
            "symbol": symbol, "side": side, "quantity": quantity, "price": str(px),
            "amount": str(amount), "commission": str(fee), "cash_flow": str(cash),
            "source": source, "verified": False, "external_id": external_id}


def add_trade(**kwargs) -> tuple[dict, bool]:
    trade = normalize_trade(**kwargs)
    with db.session() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO quant_trade_events
            (fingerprint,trade_date,trade_time,symbol,side,quantity,price,commission,source,verified,external_id,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (trade["fingerprint"], trade["trade_date"], trade["trade_time"], trade["symbol"],
             trade["side"], trade["quantity"], trade["price"], trade["commission"],
             trade["source"], 0, trade["external_id"], db.utc_now()),
        )
    return trade, cur.rowcount == 1


def seed_20261106() -> dict:
    """Idempotent import from the user's supplied historical screenshot and fills."""
    inserted = 0
    for symbol, time_, side, quantity, price in SEED_TRADES:
        _, added = add_trade(trade_date=SEED_DAY, trade_time=time_, symbol=symbol,
                             side=side, quantity=quantity, price=price,
                             source="user_provided_20261106")
        inserted += added
    with db.session() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO quant_account_history
            (snapshot_date,total_assets,position_value,cash_available,total_pnl,day_pnl,source,verified,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (SEED_DAY, "111527.05", "108672.70", "2854.35", "-28966.80", "-2925.10",
             "user_screenshot_20261106", 0, db.utc_now()),
        )
        conn.executemany(
            """INSERT OR IGNORE INTO quant_holding_history
            (snapshot_date,symbol,quantity,source,verified,created_at) VALUES(?,?,?,?,?,?)""",
            [(SEED_DAY, symbol, quantity, "user_screenshot_20261106", 0, db.utc_now())
             for symbol, quantity in SEED_HOLDINGS.items()],
        )
    return {"inserted_trades": inserted, "seed_date": SEED_DAY}


def history(trade_date: str) -> dict:
    date.fromisoformat(trade_date)
    with db.session() as conn:
        trades = [dict(row) for row in conn.execute(
            "SELECT * FROM quant_trade_events WHERE trade_date=? ORDER BY trade_time,symbol,fingerprint",
            (trade_date,),
        )]
        snapshot = conn.execute("SELECT * FROM quant_account_history WHERE snapshot_date=?", (trade_date,)).fetchone()
        holdings = [dict(row) for row in conn.execute(
            "SELECT * FROM quant_holding_history WHERE snapshot_date=? ORDER BY symbol", (trade_date,),
        )]
    for row in trades:
        amount = Decimal(row["price"]) * row["quantity"]
        fee = Decimal(row["commission"])
        row["amount"] = str(amount.quantize(MONEY, rounding=ROUND_HALF_UP))
        row["cash_flow"] = str((amount - fee if row["side"] == "sell" else -amount - fee).quantize(MONEY))
        row["verified"] = bool(row["verified"])
    return {"date": trade_date, "trades": trades, "trade_summary": summarize_trades(trades),
            "account_snapshot": dict(snapshot) if snapshot else None,
            "holding_snapshot": holdings,
            "notice": "历史截图和用户提供成交，未与券商交割单核对；不得视作当前实时账户。"}


def summarize_trades(trades: list[dict]) -> dict:
    """Summarize same-day fills without inventing a position or closing price.

    Buy and sell fills are paired by aggregate quantity per security.  This is
    deliberately a fill-ledger result: unmatched quantities remain separate
    and are never folded into realised T profit.
    """
    by_symbol: dict[str, dict] = {}
    total_fees = Decimal("0")
    for trade in trades:
        symbol = trade["symbol"]
        side = trade["side"]
        quantity = int(trade["quantity"])
        price = Decimal(str(trade["price"]))
        fee = Decimal(str(trade["commission"]))
        total_fees += fee
        row = by_symbol.setdefault(symbol, {
            "symbol": symbol, "buy_quantity": 0, "sell_quantity": 0,
            "buy_amount": Decimal("0"), "sell_amount": Decimal("0"),
            "buy_fees": Decimal("0"), "sell_fees": Decimal("0"),
        })
        row[f"{side}_quantity"] += quantity
        row[f"{side}_amount"] += price * quantity
        row[f"{side}_fees"] += fee

    items = []
    realised_total = Decimal("0")
    for symbol in sorted(by_symbol):
        row = by_symbol[symbol]
        buy_qty = row["buy_quantity"]
        sell_qty = row["sell_quantity"]
        matched = min(buy_qty, sell_qty)
        avg_buy = row["buy_amount"] / buy_qty if buy_qty else Decimal("0")
        avg_sell = row["sell_amount"] / sell_qty if sell_qty else Decimal("0")
        matched_buy_fee = row["buy_fees"] * Decimal(matched) / buy_qty if buy_qty else Decimal("0")
        matched_sell_fee = row["sell_fees"] * Decimal(matched) / sell_qty if sell_qty else Decimal("0")
        realised = ((avg_sell - avg_buy) * matched - matched_buy_fee - matched_sell_fee).quantize(
            MONEY, rounding=ROUND_HALF_UP)
        realised_total += realised
        items.append({
            "symbol": symbol,
            "buy_quantity": buy_qty,
            "sell_quantity": sell_qty,
            "net_quantity": buy_qty - sell_qty,
            "matched_quantity": matched,
            "unmatched_buy_quantity": max(0, buy_qty - matched),
            "unmatched_sell_quantity": max(0, sell_qty - matched),
            "average_buy_price": str(avg_buy.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)) if buy_qty else None,
            "average_sell_price": str(avg_sell.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)) if sell_qty else None,
            "realised_t_pnl": str(realised),
            "total_fees": str((row["buy_fees"] + row["sell_fees"]).quantize(MONEY)),
        })
    return {
        "items": items,
        "trade_count": len(trades),
        "total_fees": str(total_fees.quantize(MONEY)),
        "realised_t_pnl": str(realised_total.quantize(MONEY)),
        "method": "同日买卖按各方加权均价配对；手续费按已配对数量分摊",
        "notice": "只计入已配对做T价差；未配对加仓不计入已实现收益。",
    }


def replay_analysis(ledger: dict, minute_data: dict[str, dict], hindsight_quantity: int | None = None) -> dict:
    """Replay recorded fills against source-labelled minute bars.

    ``actual_vs_no_trade`` is the terminal wealth difference at the final
    minute: cumulative trade cash flow + net quantity change * close.  It is
    independent of the original position's cost, while the historical holding
    snapshot is used only to expose the implied opening quantity.
    """
    trades = ledger.get("trades") or []
    summary_by_symbol = {row["symbol"]: row for row in ledger["trade_summary"]["items"]}
    holding_by_symbol = {row["symbol"]: int(row["quantity"]) for row in ledger.get("holding_snapshot") or []}
    trade_by_symbol: dict[str, list[dict]] = {}
    for trade in trades:
        trade_by_symbol.setdefault(trade["symbol"], []).append(trade)

    items = []
    portfolio_series: dict[str, Decimal] = {}
    total_difference = Decimal("0")
    total_theoretical = Decimal("0")
    total_realised = Decimal(ledger["trade_summary"]["realised_t_pnl"])
    validated_count = 0
    validation_count = 0
    for symbol, trade_summary in summary_by_symbol.items():
        market = minute_data.get(symbol) or {}
        rows = market.get("rows") or []
        row_by_minute = {str(row.get("datetime", ""))[:16]: row for row in rows}
        fills = []
        for trade in trade_by_symbol.get(symbol, []):
            minute = f"{trade['trade_date']} {trade['trade_time']}"
            bar = row_by_minute.get(minute)
            price = Decimal(str(trade["price"]))
            in_range = None
            if bar:
                in_range = Decimal(str(bar["low"])) <= price <= Decimal(str(bar["high"]))
                validation_count += 1
                validated_count += int(in_range)
            fills.append({"fingerprint": trade["fingerprint"], "minute": minute,
                          "bar_found": bool(bar), "price_within_minute_range": in_range})

        close = Decimal(str(rows[-1]["close"])) if rows else None
        cash_flow = sum((Decimal(str(row["cash_flow"])) for row in trade_by_symbol.get(symbol, [])), Decimal("0"))
        net_quantity = int(trade_summary["net_quantity"])
        difference = (cash_flow + Decimal(net_quantity) * close).quantize(MONEY) if close is not None else None
        realised = Decimal(trade_summary["realised_t_pnl"])
        extra_effect = (difference - realised).quantize(MONEY) if difference is not None else None
        if difference is not None:
            total_difference += difference

        matched = int(trade_summary["matched_quantity"])
        theoretical = None
        simulation_quantity = int(hindsight_quantity) if hindsight_quantity else matched
        if rows and simulation_quantity:
            low = min(Decimal(str(row["low"])) for row in rows)
            high = max(Decimal(str(row["high"])) for row in rows)
            buy_fee = max(MIN_FEE, low * simulation_quantity * FEE_RATE)
            sell_fee = max(MIN_FEE, high * simulation_quantity * FEE_RATE)
            theoretical = ((high - low) * simulation_quantity - buy_fee - sell_fee).quantize(MONEY)
            total_theoretical += theoretical

        events: dict[str, list[dict]] = {}
        for trade in trade_by_symbol.get(symbol, []):
            events.setdefault(f"{trade['trade_date']} {trade['trade_time']}", []).append(trade)
        running_cash = Decimal("0")
        running_quantity = 0
        strategy_series = []
        for row in rows:
            minute = str(row.get("datetime", ""))[:16]
            for trade in events.get(minute, []):
                running_cash += Decimal(str(trade["cash_flow"]))
                running_quantity += int(trade["quantity"]) * (1 if trade["side"] == "buy" else -1)
            equity = (running_cash + Decimal(running_quantity) * Decimal(str(row["close"]))).quantize(MONEY)
            strategy_series.append((minute, equity))
            portfolio_series[minute] = portfolio_series.get(minute, Decimal("0")) + equity
        peak = Decimal("0")
        max_drawdown = Decimal("0")
        for _, equity in strategy_series:
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak - equity)

        closing_holding = holding_by_symbol.get(symbol)
        items.append({
            "symbol": symbol, "source": market.get("source"), "minute_count": len(rows),
            "first_minute": str(rows[0]["datetime"]) if rows else None,
            "last_minute": str(rows[-1]["datetime"]) if rows else None,
            "closing_price": str(close) if close is not None else None,
            "closing_holding_snapshot": closing_holding,
            "implied_opening_quantity": closing_holding - net_quantity if closing_holding is not None else None,
            "actual_vs_no_trade": str(difference) if difference is not None else None,
            "realised_t_pnl": str(realised.quantize(MONEY)),
            "extra_position_effect": str(extra_effect) if extra_effect is not None else None,
            "max_drawdown_yuan": str(max_drawdown.quantize(MONEY)),
            "hindsight_optimal_pnl": str(theoretical) if theoretical is not None else None,
            "hindsight_quantity": simulation_quantity if rows else None,
            "fills": fills,
        })

    portfolio_peak = Decimal("0")
    portfolio_drawdown = Decimal("0")
    for minute in sorted(portfolio_series):
        equity = portfolio_series[minute]
        portfolio_peak = max(portfolio_peak, equity)
        portfolio_drawdown = max(portfolio_drawdown, portfolio_peak - equity)
    assets = Decimal(str((ledger.get("account_snapshot") or {}).get("total_assets") or "0"))
    return {
        "date": ledger.get("date"), "items": items,
        "actual_vs_no_trade": str(total_difference.quantize(MONEY)),
        "realised_t_pnl": str(total_realised.quantize(MONEY)),
        "extra_position_effect": str((total_difference - total_realised).quantize(MONEY)),
        "max_drawdown_yuan": str(portfolio_drawdown.quantize(MONEY)),
        "max_drawdown_pct_of_snapshot_assets": str((portfolio_drawdown / assets * 100).quantize(Decimal("0.01"))) if assets else None,
        "hindsight_optimal_pnl": str(total_theoretical.quantize(MONEY)),
        "hindsight_quantity": int(hindsight_quantity) if hindsight_quantity else None,
        "fill_validation": {"checked": validation_count, "within_range": validated_count},
        "notice": "实际对比按收盘价估值；理论模拟使用每只标的的当日最低价买入、最高价卖出，并扣除买卖手续费；不是可执行交易信号。",
    }
