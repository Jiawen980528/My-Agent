"""Public-market data and deterministic, research-only strategy calculations.

The module deliberately does not contain broker credentials or order-placement code.
Daily bars are requested on demand, then a transparent moving-average crossover
simulation can be run locally against those bars.
"""
from __future__ import annotations

from statistics import mean
import re
from typing import Any
import json
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


_SYMBOL_RE = re.compile(r"^(?:(sh|sz|bj)?)(\d{6})$", re.IGNORECASE)
_SH_INDEX = {"000001", "000300", "000905", "000016", "000688", "000852", "000010"}
_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}
_MARKET_CACHE: tuple[float, dict[str, Any]] | None = None
_SENTIMENT_CACHE: tuple[float, dict[str, Any]] | None = None


def normalize_symbol(symbol: str) -> tuple[str, str]:
    """Return a provider symbol and a six-digit display code without guessing bad input."""
    raw = str(symbol or "").strip().lower()
    match = _SYMBOL_RE.fullmatch(raw)
    if not match:
        raise ValueError("代码格式不正确，请输入 6 位代码，例如 600519、510300 或 sh000001")
    explicit, code = match.groups()
    if explicit:
        return f"{explicit}{code}", code
    if code.startswith("92") or code.startswith(("4", "8")):
        prefix = "bj"
    elif code.startswith(("5", "6", "9")) or code in _SH_INDEX:
        prefix = "sh"
    else:
        prefix = "sz"
    return f"{prefix}{code}", code


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _parse_bars(raw_bars: list[Any]) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for item in raw_bars:
        if not isinstance(item, list) or len(item) < 6:
            continue
        date = str(item[0])[:10]
        op, close, high, low, volume = (_number(item[1]), _number(item[2]), _number(item[3]), _number(item[4]), _number(item[5]))
        if not date or close <= 0:
            continue
        bars.append({"date": date, "open": op or close, "close": close, "high": high or close, "low": low or close, "volume": volume})
    return bars


def _fetch_json(url: str, params: dict[str, str], headers: dict[str, str], timeout: int) -> dict[str, Any]:
    query = urlencode(params)
    request = Request(f"{url}?{query}", headers=headers)
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_text(url: str, headers: dict[str, str], timeout: int) -> str:
    request = Request(url, headers=headers)
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("gb18030", "replace")


def quote_snapshot(symbols: list[str]) -> dict[str, dict[str, Any]]:
    """Batch Tencent quote snapshot. This endpoint supports stocks, ETFs and indices."""
    normalized = [normalize_symbol(symbol)[0] for symbol in symbols]
    raw = _fetch_text("https://qt.gtimg.cn/q=" + ",".join(normalized), {"User-Agent": "Mozilla/5.0"}, 12)
    results: dict[str, dict[str, Any]] = {}
    for line in raw.split(";"):
        if '="' not in line or "~" not in line:
            continue
        provider_symbol = line.split("=")[0].split("_")[-1].lower()
        parts = line.split('"', 2)[1].split("~")
        if len(parts) < 39:
            continue
        results[provider_symbol] = {
            "symbol": provider_symbol,
            "code": provider_symbol[2:],
            "name": parts[1] or provider_symbol,
            "price": _number(parts[3]),
            "change_pct": _number(parts[32]),
            "amount_wan": _number(parts[37]),
            "turnover_pct": _number(parts[38]),
        }
    return results


_MARKET_GROUPS = [
    ("core", "核心指数", ["sh000001", "sh000300", "sz399006", "sh000688"]),
    ("ai", "AI · 数字科技", ["300308", "002230", "688041", "002415"]),
    ("energy", "新能源 · 高端制造", ["300750", "002594", "601012", "002459"]),
    ("consumer", "消费 · 医药", ["600519", "000858", "600276", "300760"]),
    ("finance", "金融 · 高股息", ["600036", "601318", "601088", "600900"]),
]


def market_map() -> dict[str, Any]:
    """A compact, live quote-backed market map for the workstation landing view."""
    global _MARKET_CACHE
    now = time.monotonic()
    if _MARKET_CACHE and now - _MARKET_CACHE[0] < 20:
        return _MARKET_CACHE[1]
    all_symbols = [symbol for _, _, symbols in _MARKET_GROUPS for symbol in symbols]
    try:
        quotes = quote_snapshot(all_symbols)
    except Exception as exc:
        raise RuntimeError("大盘快照暂时不可用，请稍后刷新") from exc
    groups = []
    for group_id, label, symbols in _MARKET_GROUPS:
        # _MARKET_GROUPS accepts both raw codes and explicit market prefixes;
        # quote_snapshot keys are always normalized provider symbols.
        items = [quotes[normalize_symbol(symbol)[0]] for symbol in symbols if normalize_symbol(symbol)[0] in quotes]
        if not items:
            continue
        groups.append({
            "id": group_id,
            "label": label,
            "change_pct": round(mean(item["change_pct"] for item in items), 2),
            "items": items,
        })
    result = {"updated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "groups": groups, "source": "腾讯财经公开行情"}
    _MARKET_CACHE = (now, result)
    return result


def _sentiment_pool(endpoint: str, sort: str, trade_date: str) -> list[dict[str, Any]]:
    """One Eastmoney limit-pool request; called serially and cached by market_sentiment."""
    url = f"https://push2ex.eastmoney.com/{endpoint}"
    params = {
        "ut": "7eea3edcaed734bea9cbfc24409ed989", "dpt": "wz.ztzt",
        "Pageindex": "0", "pagesize": "10000", "sort": sort, "date": trade_date,
    }
    payload = _fetch_json(url, params, {**_HEADERS, "Referer": "https://quote.eastmoney.com/"}, 15)
    return (payload.get("data") or {}).get("pool") or []


def market_sentiment() -> dict[str, Any]:
    """Limit-up sentiment snapshot. Empty pools are normal on non-trading days."""
    global _SENTIMENT_CACHE
    now = time.monotonic()
    if _SENTIMENT_CACHE and now - _SENTIMENT_CACHE[0] < 60:
        return _SENTIMENT_CACHE[1]
    trade_date = time.strftime("%Y%m%d")
    try:
        pools = {}
        for endpoint, sort, key in (
            ("getTopicZTPool", "fbt:asc", "limit_up"),
            ("getTopicZBPool", "fbt:asc", "open_board"),
            ("getTopicDTPool", "fund:asc", "limit_down"),
            ("getYesterdayZTPool", "zs:desc", "yesterday_limit_up"),
        ):
            pools[key] = _sentiment_pool(endpoint, sort, trade_date)
            time.sleep(0.35)  # public upstream; serial calls avoid a burst against one IP
    except Exception as exc:
        raise RuntimeError("市场情绪数据暂时不可用，请稍后刷新") from exc
    ladder: dict[str, int] = {}
    for item in pools["limit_up"]:
        days = str(item.get("lbc") or 1)
        ladder[days] = ladder.get(days, 0) + 1
    limit_up, open_board = len(pools["limit_up"]), len(pools["open_board"])
    result = {
        "date": trade_date,
        "limit_up": limit_up,
        "open_board": open_board,
        "limit_down": len(pools["limit_down"]),
        "max_height": max((int(item.get("lbc") or 0) for item in pools["limit_up"]), default=0),
        "break_rate": round(open_board / (limit_up + open_board) * 100, 1) if limit_up + open_board else 0,
        "ladder": [{"days": int(days), "count": count} for days, count in sorted(ladder.items(), key=lambda row: int(row[0]))],
        "note": "非交易日或盘后数据更新前，统计可能为空。",
        "source": "东方财富公开涨停池",
    }
    _SENTIMENT_CACHE = (now, result)
    return result


def daily_kline(symbol: str, days: int = 240, http_get=None) -> dict[str, Any]:
    """Fetch forward-adjusted daily bars from Tencent's public quote endpoint.

    Tencent is used first because it is independent from the Eastmoney source used
    elsewhere in the product. The endpoint returns at most a few hundred bars per
    request, which is sufficient for an interactive chart and MA backtest.
    """
    provider_symbol, code = normalize_symbol(symbol)
    days = max(30, min(int(days), 1000))
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    try:
        params = {"param": f"{provider_symbol},day,,,{days},qfq"}
        if http_get is None:
            payload = _fetch_json(url, params, _HEADERS, 12)
        else:
            response = http_get(url, params=params, headers=_HEADERS, timeout=12)
            response.raise_for_status()
            payload = response.json()
        node = (payload.get("data") or {}).get(provider_symbol) or {}
        bars = _parse_bars(node.get("qfqday") or node.get("day") or [])
    except Exception as exc:
        raise RuntimeError("日 K 数据暂时不可用，请稍后刷新") from exc
    if len(bars) < 20:
        raise RuntimeError("该代码暂未返回足够的日 K 数据；请检查代码或稍后重试")
    quote = node.get("qt") or {}
    if isinstance(quote, dict):
        quote = quote.get(provider_symbol) or next(iter(quote.values()), [])
    name = quote[1] if isinstance(quote, list) and len(quote) > 1 else code
    return {
        "symbol": code,
        "provider_symbol": provider_symbol,
        "name": str(name),
        "source": "腾讯财经公开行情",
        "adjustment": "前复权（qfq）",
        "bars": bars[-days:],
    }


def _moving_average(values: list[float], end: int, window: int) -> float:
    return mean(values[end - window + 1 : end + 1])


def ma_crossover_backtest(
    bars: list[dict[str, Any]], short_window: int = 10, long_window: int = 30,
    initial_capital: float = 100_000, fee_bps: float = 5,
) -> dict[str, Any]:
    """Long-only MA crossover simulation, executed at the following day's open.

    It is intentionally a simple, inspectable baseline rather than a trading
    recommendation. It uses no future price when deciding to buy or sell.
    """
    if short_window < 2 or long_window <= short_window or long_window > 250:
        raise ValueError("均线参数需要满足：2 ≤ 短均线 < 长均线 ≤ 250")
    if len(bars) < long_window + 2:
        raise ValueError("日 K 数量不足，请把时间范围调大后再回测")
    if initial_capital < 10_000 or initial_capital > 100_000_000:
        raise ValueError("初始资金需在 10,000 到 100,000,000 之间")

    closes = [float(row["close"]) for row in bars]
    cash, shares = float(initial_capital), 0
    trades: list[dict[str, Any]] = []
    equity_curve: list[float] = []
    fee_rate = max(0, min(float(fee_bps), 100)) / 10_000

    for index in range(long_window, len(bars) - 1):
        prev_short = _moving_average(closes, index - 1, short_window)
        prev_long = _moving_average(closes, index - 1, long_window)
        now_short = _moving_average(closes, index, short_window)
        now_long = _moving_average(closes, index, long_window)
        next_bar = bars[index + 1]
        price = max(float(next_bar["open"]), 0.01)
        if prev_short <= prev_long and now_short > now_long and shares == 0:
            quantity = int(cash / (price * (1 + fee_rate)) / 100) * 100
            if quantity:
                cost = quantity * price * (1 + fee_rate)
                cash -= cost
                shares = quantity
                trades.append({"date": next_bar["date"], "side": "买入", "price": round(price, 3), "shares": quantity})
        elif prev_short >= prev_long and now_short < now_long and shares:
            proceeds = shares * price * (1 - fee_rate)
            cash += proceeds
            trades.append({"date": next_bar["date"], "side": "卖出", "price": round(price, 3), "shares": shares})
            shares = 0
        equity_curve.append(cash + shares * closes[index])

    ending_equity = cash + shares * closes[-1]
    peak, max_drawdown = float(initial_capital), 0.0
    for equity in equity_curve + [ending_equity]:
        peak = max(peak, equity)
        max_drawdown = min(max_drawdown, equity / peak - 1)
    buy_hold = closes[-1] / closes[long_window] - 1
    return {
        "strategy": f"MA{short_window}/MA{long_window} 金叉/死叉（下一交易日开盘成交）",
        "period": {"start": bars[long_window]["date"], "end": bars[-1]["date"], "bars": len(bars)},
        "initial_capital": round(initial_capital, 2),
        "ending_equity": round(ending_equity, 2),
        "return_pct": round((ending_equity / initial_capital - 1) * 100, 2),
        "buy_hold_return_pct": round(buy_hold * 100, 2),
        "max_drawdown_pct": round(max_drawdown * 100, 2),
        "trade_count": len(trades),
        "trades": trades[-50:],
        "note": "研究回测，不代表未来收益；未包含滑点、停牌、涨跌停无法成交及完整税费。",
    }
