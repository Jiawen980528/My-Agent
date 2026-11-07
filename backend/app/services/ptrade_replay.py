"""Read-only PTrade ETF minute import and trade replay. No broker order calls."""
from __future__ import annotations

import csv
import io
import math
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
TARGET_DAY = "2026-11-06"
SYMBOLS = {"159558.SZ", "588080.SS"}
TRADES = {
    "159558.SZ": [("09:34", "sell", 23800, .803), ("10:55", "buy", 12000, .830),
                  ("11:17", "buy", 12100, .824), ("13:57", "buy", 12300, .821)],
    "588080.SS": [("09:38", "sell", 10000, 1.273), ("10:55", "buy", 7600, 1.304),
                  ("13:40", "buy", 7700, 1.291)],
}
FIELDS = ("symbol", "datetime", "open", "high", "low", "close", "volume", "amount", "source")


def _db(data_dir: Path) -> Path:
    return data_dir / "ptrade_etf_replay.sqlite3"


def _minute_allowed(dt: datetime) -> bool:
    t = dt.hour * 60 + dt.minute
    return 9 * 60 + 30 <= t <= 11 * 60 + 30 or 13 * 60 <= t <= 15 * 60


def _coverage(rows: list[dict]) -> dict:
    stamps = {row["datetime"][11:16] for row in rows}
    options = []
    for offset in (0, 1):
        expected = {f"{minute // 60:02d}:{minute % 60:02d}" for minute in
                    list(range(570+offset, 690+offset)) + list(range(780+offset, 900+offset))}
        options.append((len(expected-stamps), len(stamps-expected)))
    missing, extra = min(options, key=lambda item: sum(item))
    return {"complete": len(rows) == 240 and missing == 0 and extra == 0,
            "missing_minutes": missing, "unexpected_minutes": extra}


def parse_csv(raw: bytes) -> tuple[list[dict], dict]:
    if len(raw) > 300_000:
        raise ValueError("CSV 超过 300 KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV 必须使用 UTF-8 编码") from exc
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or set(reader.fieldnames) != set(FIELDS):
        raise ValueError("CSV 字段必须为 symbol,datetime,open,high,low,close,volume,amount,source")
    rows = []
    seen = set()
    for line, item in enumerate(reader, 2):
        if line > 1000:
            raise ValueError("CSV 行数过多")
        symbol = (item.get("symbol") or "").strip().upper()
        if symbol not in SYMBOLS:
            raise ValueError(f"第 {line} 行证券代码不在首批支持范围")
        try:
            dt = datetime.fromisoformat((item.get("datetime") or "").strip())
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=SHANGHAI)
            elif dt.utcoffset() != timedelta(hours=8):
                raise ValueError("时区必须为北京时间 +08:00")
            if dt.second or dt.microsecond or dt.date().isoformat() != TARGET_DAY or not _minute_allowed(dt):
                raise ValueError("日期或交易时段不正确")
            values = {key: float(item[key]) for key in ("open", "high", "low", "close", "volume", "amount")}
            if any(not math.isfinite(value) or value < 0 for value in values.values()):
                raise ValueError("数值必须非负且有限")
            if min(values[key] for key in ("open", "high", "low", "close")) <= 0:
                raise ValueError("价格必须大于零")
            if values["low"] > min(values["open"], values["close"]) or values["high"] < max(values["open"], values["close"]):
                raise ValueError("OHLC 顺序错误")
            source = (item.get("source") or "").strip()
            if source != "PTrade":
                raise ValueError("来源必须为 PTrade；不得把其他行情标注为券商数据")
            key = (symbol, dt.isoformat(timespec="minutes"))
            if key in seen:
                raise ValueError("CSV 含重复分钟")
            seen.add(key)
            rows.append({"symbol": symbol, "datetime": key[1], **values, "source": source})
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"第 {line} 行无效：{exc}") from exc
    if not rows:
        raise ValueError("CSV 没有有效分钟行情")
    rows.sort(key=lambda item: (item["symbol"], item["datetime"]))
    counts = {symbol: sum(row["symbol"] == symbol for row in rows) for symbol in sorted(SYMBOLS)}
    return rows, {"counts": counts, "coverage": {symbol: _coverage([row for row in rows if row["symbol"] == symbol]) for symbol in counts},
                  "volume_unit": "份（PTrade 原始 volume；请在客户端核实券商口径）",
                  "amount_unit": "元", "source": "PTrade"}


def save_csv(data_dir: Path, raw: bytes) -> dict:
    rows, report = parse_csv(raw)
    path = _db(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=10) as db:
        db.execute("CREATE TABLE IF NOT EXISTS minute (symbol TEXT NOT NULL, datetime TEXT NOT NULL, "
                   "open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, "
                   "volume REAL NOT NULL, amount REAL NOT NULL, source TEXT NOT NULL, "
                   "PRIMARY KEY(symbol,datetime))")
        db.executemany("INSERT INTO minute VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol,datetime) "
                       "DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,"
                       "volume=excluded.volume,amount=excluded.amount,source=excluded.source",
                       [tuple(row[key] for key in FIELDS) for row in rows])
    return report


def load(data_dir: Path, symbol: str) -> list[dict]:
    if symbol not in SYMBOLS or not _db(data_dir).exists():
        return []
    with sqlite3.connect(_db(data_dir), timeout=10) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("SELECT * FROM minute WHERE symbol=? AND datetime>=? "
                                               "AND datetime<? ORDER BY datetime", (symbol, TARGET_DAY, "2026-11-07"))]


def replay(symbol: str, rows: list[dict], source: str = "PTrade") -> dict:
    trades = []
    cash = 0.0
    fee_total = 0.0
    sold = 0
    bought = 0
    for hm, side, qty, price in TRADES[symbol]:
        fee = max(5.0, price * qty * .0001)
        signed = price * qty if side == "sell" else -price * qty
        cash += signed - fee
        fee_total += fee
        sold += qty if side == "sell" else 0
        bought += qty if side == "buy" else 0
        trades.append({"datetime": f"{TARGET_DAY}T{hm}:00+08:00", "side": side,
                       "qty": qty, "price": price, "fee": round(fee, 2), "cash_flow": round(signed-fee, 2)})
    matched = min(sold, bought)
    matched_left = matched
    covered_cost = 0.0
    covered_fee = 0.0
    for trade in trades:
        if trade["side"] == "buy" and matched_left:
            q = min(matched_left, trade["qty"])
            covered_cost += q * trade["price"]
            covered_fee += trade["fee"] * q / trade["qty"]
            matched_left -= q
    sale_proceeds = sum(t["qty"]*t["price"] - t["fee"] for t in trades if t["side"] == "sell")
    t_spread = sale_proceeds - covered_cost - covered_fee
    extra = bought - sold
    close = rows[-1]["close"] if rows else None
    incremental = cash + extra * close if close is not None else None
    best = None
    backtest = None
    support = resistance = None
    if len(rows) >= 20:
        # Hindsight bound: one complete buy/sell round trip, price at minute close.
        lowest = (rows[0]["close"], 0)
        best_trade = None
        for index in range(1, len(rows)):
            price = rows[index]["close"]
            spread = price - lowest[0]
            if best_trade is None or spread > best_trade[0]:
                best_trade = (spread, lowest[1], index)
            if price < lowest[0]:
                lowest = (price, index)
        if best_trade:
            buy_price = rows[best_trade[1]]["close"]
            sell_price = rows[best_trade[2]]["close"]
            theoretical = matched*(sell_price-buy_price)-max(5, matched*buy_price*.0001)-max(5, matched*sell_price*.0001)
            best = {"buy_time": rows[best_trade[1]]["datetime"] if theoretical > 0 else None,
                    "sell_time": rows[best_trade[2]]["datetime"] if theoretical > 0 else None,
                    "pnl": round(max(0, theoretical), 2),
                    "disclaimer": "事后最优，使用未来行情挑选时点，不能作为可执行策略。"}
        # Causal illustrative strategy: signal from completed closes; fill at next open.
        position = 0
        strategy_cash = 0.0
        strategy_fees = 0.0
        events = []
        peak = 0.0
        max_drawdown = 0.0
        for index in range(20, len(rows)):
            prior = rows[:index]
            sma5 = sum(bar["close"] for bar in prior[-5:]) / 5
            sma20 = sum(bar["close"] for bar in prior[-20:]) / 20
            fill = rows[index]
            if position == 0 and sma5 > sma20 and len(events) == 0:
                fee = max(5, matched*fill["open"]*.0001)
                strategy_cash -= matched*fill["open"] + fee
                strategy_fees += fee
                position = matched
                events.append({"side": "buy", "time": fill["datetime"], "price": fill["open"]})
            elif position and sma5 < sma20:
                fee = max(5, position*fill["open"]*.0001)
                strategy_cash += position*fill["open"] - fee
                strategy_fees += fee
                position = 0
                events.append({"side": "sell", "time": fill["datetime"], "price": fill["open"]})
            equity = strategy_cash + position*fill["close"]
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak-equity)
        if position:
            fee = max(5, position*rows[-1]["close"]*.0001)
            strategy_cash += position*rows[-1]["close"] - fee
            strategy_fees += fee
            events.append({"side": "sell", "time": rows[-1]["datetime"], "price": rows[-1]["close"]})
        backtest = {"pnl": round(strategy_cash, 2), "max_drawdown_yuan": round(max_drawdown, 2),
                    "trade_count": len(events), "cost": round(strategy_fees, 2), "events": events,
                    "rule": "前20根已完成分钟K的MA5高于MA20时，下根开盘买入；跌破时下根开盘卖出，收盘强制平仓。仅作无未来函数的示例，不含滑点。"}
        support = min(bar["low"] for bar in rows[-20:])
        resistance = max(bar["high"] for bar in rows[-20:])
    return {"symbol": symbol, "date": TARGET_DAY, "source": source if rows else "awaiting_PTrade_CSV",
            "rows": rows, "row_count": len(rows), "coverage": _coverage(rows), "complete": _coverage(rows)["complete"],
            "trades": trades, "cash_flow": round(cash, 2), "fees": round(fee_total, 2),
            "matched_t_qty": matched, "matched_t_pnl": round(t_spread, 2), "extra_qty": extra,
            "close": close, "versus_no_trade": round(incremental, 2) if incremental is not None else None,
            "extra_position_mark_to_close": round(incremental-t_spread, 2) if incremental is not None else None,
            "hindsight_best": best, "causal_backtest": backtest,
            "support_20m": support, "resistance_20m": resistance,
            "note": "与不交易比较使用同日收盘价对额外持仓估值；未包含持仓初始成本及其他税费。"}
