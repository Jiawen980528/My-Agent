"""受 TickFlow 登录保护的 MyAgent 量化模型桥接。"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sqlite3
import json
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response

from app.config import settings
from app.services import fund_flow_archive, ptrade_replay, research_pool
from app.services.decision_engine import build_decision
from app.services.kline_sync import fetch_minute_single, selected_minute_source
from app.services.market_volume_forecast import forecast_market_amount
from app.services.volume_forecast import forecast_amount
from app.tickflow.capabilities import Cap

router = APIRouter(prefix="/api/myagent", tags=["myagent-bridge"])


def _recommendations_path(data_dir):
    return data_dir / "user_data" / "myagent_recommendations.json"


def _recommendation_reviews_path(data_dir):
    return data_dir / "user_data" / "myagent_recommendation_reviews.json"


def _load_recommendations(data_dir) -> list[dict]:
    path = _recommendations_path(data_dir)
    try:
        rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except (OSError, ValueError):
        rows = []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _save_recommendation_record(data_dir, record: dict) -> dict:
    """Save one immutable-ish recommendation snapshot, replacing only the same id."""
    record = dict(record)
    record["items"] = [item for item in record.get("items", [])[:20]
                       if isinstance(item, dict) and item.get("symbol")]
    rows = [row for row in _load_recommendations(data_dir) if row.get("id") != record.get("id")]
    rows.insert(0, record)
    path = _recommendations_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows[:500], ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def _summarize_returns(values: list[float]) -> dict:
    if not values:
        return {"tracked": 0, "wins": 0, "win_rate": None, "average_pct": None,
                "best_pct": None, "worst_pct": None}
    wins = sum(value >= 0 for value in values)
    return {"tracked": len(values), "wins": wins, "win_rate": round(wins / len(values) * 100, 2),
            "average_pct": round(sum(values) / len(values), 3), "best_pct": round(max(values), 3),
            "worst_pct": round(min(values), 3)}


def _adaptive_paper_threshold(data_dir, stage: str) -> tuple[int, dict]:
    """Learn conservatively from frozen prior-day reviews, never lowering risk gates."""
    path = _recommendation_reviews_path(data_dir)
    try:
        reviews = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except (OSError, ValueError):
        reviews = []
    tracked = wins = 0
    weighted_return = 0.0
    for review in reviews if isinstance(reviews, list) else []:
        stat = (review.get("by_stage") or {}).get(stage) if isinstance(review, dict) else None
        if not isinstance(stat, dict):
            continue
        count = int(stat.get("tracked") or 0)
        if count <= 0:
            continue
        tracked += count
        wins += int(stat.get("wins") or 0)
        weighted_return += count * float(stat.get("average_pct") or 0)
    average = weighted_return / tracked if tracked else None
    win_rate = wins / tracked * 100 if tracked else None
    threshold = 80
    reason = "样本不足，使用基础高分门槛"
    if tracked >= 30 and (average is not None and average < 0 or win_rate is not None and win_rate < 50):
        threshold = 85
        reason = "历史同类信号表现偏弱，提高模拟准入门槛"
    elif tracked >= 30:
        reason = "历史同类信号未恶化，维持基础高分门槛"
    return threshold, {"sample_size": tracked, "win_rate": round(win_rate, 2) if win_rate is not None else None,
                       "average_pct": round(average, 3) if average is not None else None, "reason": reason}


def finalize_recommendation_review(app_state, target: date | None = None) -> dict:
    """Freeze a daily recommendation review against the actual daily close.

    It is a signal-performance review, not a claim of trade P&L: commissions,
    slippage, fills and T+1 are separately accounted by the paper ledger.
    """
    from app.strategy import paper
    target = target or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    day = target.isoformat()
    data_dir = app_state.repo.store.data_dir
    records = [row for row in _load_recommendations(data_dir) if row.get("date") == day]
    evaluated: list[dict] = []
    returns: list[float] = []
    by_stage: dict[str, list[float]] = {}
    for record in records:
        reviewed_items: list[dict] = []
        for item in record.get("items") or []:
            symbol = str(item.get("symbol") or "")
            try:
                entry = float(item.get("price") or 0)
            except (TypeError, ValueError):
                entry = 0.0
            code = _symbol_key(symbol)
            asset_type = "etf" if code.startswith(("51", "56", "58", "15")) else "stock"
            bar = paper.read_daily_bar(data_dir, symbol, asset_type, day) if symbol and entry > 0 else None
            close = float(bar["close"]) if bar and bar.get("close") is not None else None
            change = round((close / entry - 1) * 100, 3) if close and entry > 0 else None
            reviewed_items.append({"symbol": symbol, "name": item.get("name"), "entry_price": entry or None,
                                   "close_price": close, "close_return_pct": change})
            if change is not None:
                returns.append(change)
                by_stage.setdefault(str(record.get("stage") or "未分类"), []).append(change)
        evaluated.append({"id": record.get("id"), "stage": record.get("stage"),
                          "created_at": record.get("createdAt"), "items": reviewed_items})
    review = {"date": day, "reviewed_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
              "method": "推荐价至当日真实日线收盘价；不等同模拟盘成交收益",
              "summary": _summarize_returns(returns),
              "by_stage": {stage: _summarize_returns(values) for stage, values in by_stage.items()},
              "records": evaluated}
    path = _recommendation_reviews_path(data_dir)
    try:
        existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except (OSError, ValueError):
        existing = []
    existing = [row for row in existing if isinstance(row, dict) and row.get("date") != day] if isinstance(existing, list) else []
    existing.insert(0, review)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(existing[:500], ensure_ascii=False, indent=2), encoding="utf-8")
    return review


def _symbol_key(value: object) -> str:
    return str(value or "").strip().upper().split(".", 1)[0]


def _public_market_context() -> dict:
    """Small synchronous public-data context for the scheduled scorer.

    Failures are data gaps, never implicit bullish/bearish values.
    """
    context = {"market_flow_score": 0, "external_score": 0, "missing": []}
    try:
        with httpx.Client(timeout=5.0, follow_redirects=True) as client:
            flows = []
            for secid in ("1.000001", "0.399001"):
                response = client.get(_FLOW_URL, params={"lmt": "0", "klt": "1", "fields1": "f1,f2,f3,f7",
                    "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "ut": _FLOW_UT, "secid": secid})
                response.raise_for_status()
                flows.extend(_parse_flow((response.json().get("data") or {}).get("klines") or []))
            merged = _sum_market_flows([row for row in flows if row.get("time")], [])
            main = float(merged[-1].get("main") or 0) if merged else 0.0
            context["market_flow_main"] = main
            context["market_flow_score"] = 8 if main > 0 else -6 if main < 0 else 0
            external = []
            for name, symbol in (("A50", "XIN9.SG"), ("标普500", "^GSPC"), ("纳斯达克", "^IXIC")):
                response = client.get("https://query1.finance.yahoo.com/v8/finance/chart/" + symbol,
                                      params={"range": "1d", "interval": "5m"}, headers={"User-Agent": "MyAgent/1.0"})
                response.raise_for_status()
                result = response.json().get("chart", {}).get("result") or []
                change = ((result[0].get("meta") or {}).get("regularMarketChangePercent") if result else None)
                if change is not None:
                    external.append(float(change))
            if external:
                context["external_avg_pct"] = round(sum(external) / len(external), 3)
                context["external_score"] = 5 if sum(external) >= 0 else -5
            else:
                context["missing"].append("外围/A50")
    except (httpx.HTTPError, ValueError, TypeError, KeyError, IndexError):
        context["missing"].extend(["全市场资金流", "外围/A50"])
    return context


def _score_intraday_candidate(row: dict, pool_items: list[dict], emotion: dict | None, market_context: dict) -> tuple[int, dict, bool]:
    """Deterministic admission score.  Every point maps to an observable field."""
    signals = set(str(value) for value in row.get("signals") or [])
    technical = 15
    technical += 25 if "limit_up" in signals else 0
    technical += 15 if "new_high" in signals else 0
    technical += 5 if "recovery" in signals else 0
    technical -= 25 if "broken" in signals else 0
    technical -= 35 if "limit_down" in signals else 0
    volume_ratio = float(row.get("vol_ratio_5d") or 0)
    volume = min(20, max(0, round(volume_ratio * 5)))
    key, name = _symbol_key(row.get("symbol")), str(row.get("name") or "")
    matched = [item for item in pool_items if _symbol_key(item.get("symbol")) == key or (name and item.get("name") == name)]
    pool = 15 if matched else 0
    emotion_score = int((emotion or {}).get("score") or 50)
    sentiment = max(0, min(15, round((emotion_score - 35) / 4)))
    market_flow = int(market_context.get("market_flow_score") or 0)
    external = int(market_context.get("external_score") or 0)
    score = max(0, min(100, technical + volume + pool + sentiment + market_flow + external + 25))
    blocked = bool({"broken", "limit_down"} & signals)
    detail = {
        "technical": technical, "volume": volume, "sentiment": sentiment, "research_pool": pool,
        "market_flow": market_flow, "external": external,
        "market_emotion": emotion_score, "pool_match": bool(matched),
        "missing": ["新闻催化", "个股资金流", *market_context.get("missing", [])] ,
    }
    return score, detail, score >= 65 and not blocked


def _auto_execute_paper_candidate(data_dir, record: dict) -> dict:
    """Submit at most one high-conviction paper order per symbol/day.

    This is deliberately paper-only and conservative: incomplete signals can be
    researched and recorded, but only a score of 80+ may open a simulated layer.
    """
    from app.strategy import paper
    account_id = "default"
    account = paper.get_account(data_dir, account_id)
    if account is None:
        return {"status": "skipped", "reason": "模拟账户不存在"}
    day = str(record.get("date") or "")
    existing = paper.load_orders(data_dir, account_id)
    threshold, learning = _adaptive_paper_threshold(data_dir, str(record.get("stage") or "盘中推荐"))
    for item in sorted(record.get("items") or [], key=lambda row: float(row.get("score") or 0), reverse=True):
        symbol = str(item.get("symbol") or "").strip()
        score = float(item.get("score") or 0)
        price = float(item.get("price") or 0)
        if not item.get("eligible_for_paper") or score < threshold or not symbol or price <= 0:
            continue
        marker = f"auto-recommendation:{day}:{symbol}"
        if any(str(order.get("source") or "").startswith(marker) for order in existing):
            return {"status": "skipped", "reason": "该标的今日已自动模拟", "symbol": symbol, "threshold": threshold, "learning": learning}
        amount = float(account.get("initial_cash", 100000.0)) * 0.04
        qty = int(amount / price / 100) * 100
        if qty < 100:
            return {"status": "skipped", "reason": "单层资金不足一手", "symbol": symbol, "threshold": threshold, "learning": learning}
        order, error = paper.create_order(
            data_dir, symbol, "buy", account_id=account_id, qty=qty,
            order_type="next_open", ref_price=price, source=marker,
        )
        if error:
            return {"status": "skipped", "reason": error, "symbol": symbol, "threshold": threshold, "learning": learning}
        try:
            from app.services import alert_store
            alert_store.append_many(data_dir, [{
                "ts": int(time.time() * 1000), "source": "myagent", "type": "paper_order_submitted",
                "rule_id": None, "rule_name": "高分候选自动模拟", "strategy_id": None,
                "symbol": symbol, "name": str(item.get("name") or symbol), "price": price,
                "message": f"暗黑模拟盘已提交 {symbol} 一层买入委托（评分 {score:.0f}，待下一交易日开盘撮合；不影响真实持仓）",
            }])
        except Exception as exc:  # alert persistence must never block the paper order itself
            logger.warning("paper recommendation alert write failed: %s", exc)
        return {"status": "submitted", "symbol": symbol, "score": score, "threshold": threshold, "learning": learning, "order_id": order.get("id")}
    return {"status": "skipped", "reason": f"没有达到自动模拟阈值（当前 {threshold}）的候选", "threshold": threshold, "learning": learning}


def evaluate_auto_paper_risk(app_state) -> dict:
    """Risk-only exit pass for positions opened by MyAgent's paper recommender.

    A sell needs both a material close-to-cost loss and weak market emotion.  This
    prevents a single red day from becoming an automatic exit, and never touches
    manual paper orders or the user's real holdings.
    """
    from app.strategy import paper
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    if now.weekday() >= 5:
        return {"status": "skipped", "reason": "non_trading_weekday"}
    data_dir, account_id, day = app_state.repo.store.data_dir, "default", now.date().isoformat()
    account = paper.get_account(data_dir, account_id)
    if account is None:
        return {"status": "skipped", "reason": "模拟账户不存在"}
    try:
        from app.services.market_overview_builder import build_market_overview
        emotion = int((build_market_overview(app_state.repo, getattr(app_state, "quote_service", None),
                                              getattr(app_state, "depth_service", None)).get("emotion") or {}).get("score") or 50)
    except Exception as exc:
        return {"status": "skipped", "reason": f"市场情绪不可用：{type(exc).__name__}"}
    if emotion >= 45:
        return {"status": "skipped", "reason": f"情绪 {emotion} 未触发弱市风控"}
    auto_symbols = {str(order.get("symbol")) for order in paper.load_orders(data_dir, account_id)
                    if str(order.get("source") or "").startswith("auto-recommendation:") and order.get("side") == "buy"}
    created, skipped = [], []
    for symbol in sorted(auto_symbols):
        pos = paper.load_positions(data_dir, account_id).get(symbol)
        if not pos or int(pos.get("qty") or 0) <= 0:
            continue
        marker = f"auto-risk-exit:{day}:{symbol}"
        if any(str(order.get("source") or "").startswith(marker) for order in paper.load_orders(data_dir, account_id)):
            continue
        code = _symbol_key(symbol)
        asset_type = "etf" if code.startswith(("51", "56", "58", "15")) else "stock"
        bar = paper.read_daily_bar(data_dir, symbol, asset_type, day)
        close, cost = (float(bar.get("close") or 0) if bar else 0.0), float(pos.get("avg_cost") or 0)
        if close <= 0 or cost <= 0:
            skipped.append({"symbol": symbol, "reason": "缺少当日真实收盘价"})
            continue
        drawdown = (close / cost - 1) * 100
        if drawdown > -8:
            continue
        capacity = paper.sell_capacity(data_dir, symbol, account_id)
        if capacity is None or capacity[0] <= 0:
            skipped.append({"symbol": symbol, "reason": "T+1 无可卖数量"})
            continue
        order, error = paper.create_order(data_dir, symbol, "sell", account_id=account_id,
                                          qty=int(capacity[0]), order_type="next_open", ref_price=close,
                                          source=marker)
        if error:
            skipped.append({"symbol": symbol, "reason": error})
            continue
        created.append({"symbol": symbol, "order_id": order.get("id"), "drawdown_pct": round(drawdown, 2)})
        try:
            from app.services import alert_store
            alert_store.append_many(data_dir, [{"ts": int(time.time() * 1000), "source": "myagent",
                "type": "paper_risk_exit", "rule_id": None, "rule_name": "模拟盘弱市止损", "strategy_id": None,
                "symbol": symbol, "name": "", "price": close,
                "message": f"暗黑模拟盘弱市风控：{symbol} 收盘较成本 {drawdown:.2f}%，情绪 {emotion}，已提交下一交易日卖出委托（不影响真实持仓）"}])
        except Exception as exc:
            logger.warning("paper risk alert write failed: %s", exc)
    return {"status": "ok", "market_emotion": emotion, "created": created, "skipped": skipped}


def capture_recommendation_snapshot(app_state) -> dict:
    """Persist auditable auction/intraday candidates without a browser being open.

    This deliberately records only verifiable source signals.  It does *not* claim
    that an AI or a complete multi-factor model has approved a purchase.
    """
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    minute = now.hour * 60 + now.minute
    if now.weekday() >= 5:
        return {"status": "skipped", "reason": "non_trading_weekday"}
    data_dir = app_state.repo.store.data_dir
    day = now.date().isoformat()
    bucket = now.strftime("%H%M")
    # 集合竞价：只使用独立竞价来源，绝不用拾贝结果填充。
    if 9 * 60 + 15 <= minute <= 9 * 60 + 25:
        from app.services import auction_benchmark
        payload = auction_benchmark.get_auction_benchmark(data_dir, now.date())
        if payload.get("state") != "ok" or not payload.get("items"):
            return {"status": "skipped", "reason": payload.get("state", "auction_unavailable")}
        items = [{
            "symbol": str(item.get("thscode") or item.get("ticker") or ""),
            "name": str(item.get("name") or item.get("ticker") or ""),
            "price": item.get("auction_price"),
            "score": item.get("auction_pct"),
            "signals": ["集合竞价", *(item.get("tags") or [])],
        } for item in payload["items"][:5] if item.get("thscode") or item.get("ticker")]
        record = {"id": f"auto-auction-{day}-{bucket}", "date": day, "stage": "集合竞价",
                  "createdAt": now.isoformat(timespec="seconds"), "source": "后端定时·竞价风向标",
                  "model_status": "仅竞价信号，未做完整多维复核", "items": items}
        _save_recommendation_record(data_dir, record)
        return {"status": "saved", "stage": record["stage"], "count": len(items)}
    # 盘中：读取已有 enriched 异动列，五分钟一档，避免写入每分钟重复的同一批信号。
    in_session = (9 * 60 + 30 <= minute <= 11 * 60 + 30) or (13 * 60 <= minute <= 15 * 60)
    if not in_session or now.minute % 5:
        return {"status": "skipped", "reason": "outside_capture_window"}
    from app.services.abnormal_moves import build_intraday
    payload = build_intraday(app_state.repo, limit=20)
    rows = payload.get("rows") or []
    if not rows:
        return {"status": "skipped", "reason": "no_verified_intraday_signal"}
    pool_items = research_pool.load(data_dir).get("items", [])
    market_context = _public_market_context()
    try:
        from app.services.market_overview_builder import build_market_overview
        overview = build_market_overview(app_state.repo, getattr(app_state, "quote_service", None),
                                         getattr(app_state, "depth_service", None))
        emotion = overview.get("emotion") or {}
    except Exception as exc:  # market overview failure must not suppress a verifiable intraday record
        logger.warning("recommendation market emotion unavailable: %s", exc)
        emotion = None
    scored = []
    for row in rows:
        if not row.get("symbol"):
            continue
        score, detail, eligible = _score_intraday_candidate(row, pool_items, emotion, market_context)
        scored.append({
            "symbol": str(row.get("symbol")), "name": str(row.get("name") or row.get("symbol")),
            "price": row.get("close"), "score": score, "signals": row.get("signals") or [],
            "change_pct": row.get("change_pct"), "score_detail": detail,
            "eligible_for_paper": eligible,
        })
    items = sorted(scored, key=lambda item: (not item["eligible_for_paper"], -item["score"]))[:5]
    record = {"id": f"auto-intraday-{day}-{bucket}", "date": day, "stage": "盘中推荐",
              "createdAt": now.isoformat(timespec="seconds"), "source": "后端定时·盘中异动",
              "marketEmotion": f"{(emotion or {}).get('label', '缺失')} {(emotion or {}).get('score', '—')}",
              "model_status": "准入评分：技术/量能/情绪/资料池/全市场资金流/外围；新闻催化和个股资金流若缺失会标注。仅分数≥80的候选允许自动模拟一层",
              "items": items}
    # 模拟盘独立运行：只对高阈值候选下单；失败/跳过同样写入记录，方便复盘胜率。
    record["paper_auto"] = _auto_execute_paper_candidate(data_dir, record)
    _save_recommendation_record(data_dir, record)
    return {"status": "saved", "stage": record["stage"], "count": len(items), "paper_auto": record["paper_auto"]}


@router.get("/recommendations")
def get_recommendations(request: Request, date: str | None = Query(default=None)):
    """读取 MyAgent 推荐快照；服务端持久化，避免只存在浏览器 localStorage。"""
    rows = _load_recommendations(request.app.state.repo.store.data_dir)
    if date:
        rows = [row for row in rows if row.get("date") == date]
    return {"items": rows[:500], "source": "server"}


@router.get("/recommendations/reviews")
def get_recommendation_reviews(request: Request, limit: int = Query(default=60, ge=1, le=500)):
    path = _recommendation_reviews_path(request.app.state.repo.store.data_dir)
    try:
        rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except (OSError, ValueError):
        rows = []
    rows = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    return {"items": rows[:limit], "source": "server_daily_close"}


@router.post("/recommendations/reviews/finalize")
def finalize_recommendation_review_now(request: Request, date: str | None = Query(default=None)):
    try:
        target = datetime.strptime(date, "%Y-%m-%d").date() if date else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="date 必须为 YYYY-MM-DD") from exc
    return finalize_recommendation_review(request.app.state, target)


@router.post("/recommendations")
async def save_recommendation(request: Request):
    """保存一条推荐快照；按 id 幂等，最多保留 500 条。"""
    try:
        record = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="推荐快照必须是 JSON") from exc
    if not isinstance(record, dict) or not record.get("id") or not isinstance(record.get("items"), list):
        raise HTTPException(status_code=422, detail="推荐快照缺少 id 或 items")
    record = _save_recommendation_record(request.app.state.repo.store.data_dir, record)
    return {"ok": True, "record": record, "source": "server"}


@router.post("/recommendations/{recommendation_id}/paper-execute")
async def execute_recommendation_paper(request: Request, recommendation_id: str, account: str = Query("default")):
    """将已保存推荐按固定小仓位提交到暗黑模拟盘；绝不连接真实券商。"""
    rows = _load_recommendations(request.app.state.repo.store.data_dir)
    record = next((row for row in rows if isinstance(row, dict) and row.get("id") == recommendation_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="推荐记录不存在")
    from app.strategy import paper
    try:
        account_id = paper.validate_account_id(account)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    data_dir = request.app.state.repo.store.data_dir
    acc = paper.get_account(data_dir, account_id)
    if acc is None:
        raise HTTPException(status_code=400, detail="模拟账户不存在，请先创建暗黑模拟账户")
    amount = float(acc.get("initial_cash", 100000.0)) * 0.04
    created = []
    skipped = []
    for item in record.get("items", [])[:5]:
        symbol = str(item.get("symbol") or "").strip()
        # 后端定时盘中快照带有准入标识：未过门槛的异动只保留观察记录，不能混入模拟委托。
        if "eligible_for_paper" in item and not item.get("eligible_for_paper"):
            skipped.append({"symbol": symbol, "reason": "未达到模拟盘准入门槛，仅保留观察"})
            continue
        price = float(item.get("price") or 0)
        if not symbol or price <= 0:
            skipped.append({"symbol": symbol, "reason": "推荐记录缺少有效价格"})
            continue
        qty = int(amount / price / 100) * 100
        if qty < 100:
            skipped.append({"symbol": symbol, "reason": "4%仓位不足一手"})
            continue
        order, err = paper.create_order(
            data_dir, symbol, "buy", account_id=account_id, qty=qty,
            order_type="next_open", ref_price=price,
            source=f"recommendation:{recommendation_id}",
        )
        if err:
            skipped.append({"symbol": symbol, "reason": err})
        else:
            created.append(order)
    return {"ok": True, "account": account_id, "recommendation_id": recommendation_id, "orders": created, "skipped": skipped}


@router.get("/recommendations/{recommendation_id}/paper-status")
def recommendation_paper_status(request: Request, recommendation_id: str, account: str = Query("default")):
    """Return the paper order lifecycle for an automated recommendation snapshot."""
    record = next((row for row in _load_recommendations(request.app.state.repo.store.data_dir)
                   if row.get("id") == recommendation_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="推荐记录不存在")
    auto = record.get("paper_auto") if isinstance(record.get("paper_auto"), dict) else {}
    order_id = str(auto.get("order_id") or "")
    if not order_id:
        return {"status": "not_submitted", "reason": auto.get("reason") or "该快照没有自动模拟委托"}
    from app.strategy import paper
    try:
        account_id = paper.validate_account_id(account)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    order = paper.get_order(request.app.state.repo.store.data_dir, order_id, account_id)
    if order is None:
        return {"status": "not_found", "reason": "模拟订单不存在或账户已变更", "order_id": order_id}
    return {"status": order.get("status"), "order_id": order_id, "symbol": order.get("symbol"),
            "order_type": order.get("order_type"), "created_at": order.get("created_at"),
            "filled_at": order.get("filled_at"), "fill_price": order.get("fill_price"),
            "reason": order.get("reason")}


@router.get("/research-pool")
def get_research_pool(request: Request):
    return research_pool.load(request.app.state.repo.store.data_dir)


@router.post("/research-pool/import")
def import_research_pool(request: Request, file: UploadFile = File(...)):
    raw = file.file.read(research_pool.MAX_UPLOAD_BYTES + 1)
    try:
        return research_pool.import_workbook(request.app.state.repo.store.data_dir, raw, file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

_FLOW_URL = "https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get"
_FLOW_HISTORY_URL = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
_BOARD_KLINE_URL = "https://7.push2his.eastmoney.com/api/qt/stock/kline/get"
_RANK_URL = "https://push2delay.eastmoney.com/api/qt/clist/get"
_FLOW_UT = "b2884a393a59ad64002292a3e90d46a5"
_flow_cache: dict[str, tuple[float, dict]] = {}
_flow_lock = asyncio.Lock()
_history_cache: dict[str, tuple[float, dict]] = {}
_history_lock = asyncio.Lock()
_board_catalog_cache: tuple[float, list[dict]] | None = None
_board_catalog_lock = asyncio.Lock()
_fuyao_board_catalog_cache: tuple[float, list[dict]] | None = None
_fuyao_board_catalog_lock = asyncio.Lock()
# 排除季报/公告/预亏等事件标签，避免被误当成持仓关联行业板块。
_EVENT_BOARD_WORDS = ("季报", "年报", "中报", "首亏", "预亏", "预增", "扭亏", "公告", "减持", "增持", "重组", "摘帽")
_BOARD_SEARCH_TERMS = ("半导体", "材料", "设备", "通信", "算力", "人工智能", "芯片", "光刻胶", "先进封装", "银行", "红利", "建筑装饰")


def _is_linkable_board_name(name: str) -> bool:
    text = str(name or "").strip()
    return bool(text) and not any(word in text for word in _EVENT_BOARD_WORDS)


def _board_keyword_match(item: dict, query: str) -> bool:
    """Match names even when the provider orders compound Chinese terms differently."""
    q = "".join(str(query or "").casefold().split())
    if not q:
        return True
    haystack = "".join(f"{item.get('name', '')} {item.get('code', '')}".casefold().split())
    if q in haystack:
        return True
    terms = [term for term in _BOARD_SEARCH_TERMS if term in q]
    if len(terms) < 2:
        return False
    # “半导体设备材料” may be split by the provider into “半导体设备”
    # and “半导体材料”; return both related candidates instead of zero results.
    matched = sum(term in haystack for term in terms)
    return matched >= max(2, len(terms) - 1)
logger = logging.getLogger(__name__)
_ptrade_upload_times: dict[str, list[float]] = {}

# 公开外围行情回退：TickFlow 没有相应标的时使用 Yahoo Finance chart API。
# 结果明确带 source/as_of/delay_seconds，供多维决策和交易记录标注数据新鲜度。
_EXTERNAL_MARKET_SYMBOLS = {
    'A50': 'XIN9.SG', '标普500': '^GSPC', '纳斯达克': '^IXIC', '道琼斯': '^DJI',
    '恒生指数': '^HSI', '日经225': '^N225', '股指期货': 'ES=F',
}
_external_market_cache: tuple[float, dict] | None = None
_external_market_lock = asyncio.Lock()


@router.get('/external-market')
async def external_market_context():
    """读取外围/期货公开行情，失败时返回可解释的缺失项而不是编造数据。"""
    global _external_market_cache
    now = time.time()
    if _external_market_cache and now - _external_market_cache[0] < 30:
        return _external_market_cache[1]
    async with _external_market_lock:
        now = time.time()
        if _external_market_cache and now - _external_market_cache[0] < 30:
            return _external_market_cache[1]
        items: list[dict] = []
        missing: list[str] = []
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            for name, symbol in _EXTERNAL_MARKET_SYMBOLS.items():
                try:
                    response = await client.get(
                        'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol,
                        params={'range': '1d', 'interval': '5m'},
                        headers={'User-Agent': 'MyAgent/1.0'},
                    )
                    response.raise_for_status()
                    result = response.json().get('chart', {}).get('result') or []
                    meta = result[0].get('meta', {}) if result else {}
                    price = meta.get('regularMarketPrice')
                    ts = meta.get('regularMarketTime')
                    if price is None or ts is None:
                        raise ValueError('missing quote')
                    age = max(0, int(time.time() - float(ts)))
                    items.append({'name': name, 'symbol': symbol, 'price': float(price), 'change_pct': meta.get('regularMarketChangePercent'), 'as_of': datetime.fromtimestamp(float(ts), tz=ZoneInfo('UTC')).isoformat(), 'delay_seconds': age, 'source': 'yahoo_public_delayed'})
                except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError):
                    missing.append(name)
        payload = {'items': items, 'missing': missing, 'source': 'Yahoo Finance公开行情（可能延迟）', 'fetched_at': datetime.now(tz=ZoneInfo('UTC')).isoformat(), 'max_delay_seconds': max((x['delay_seconds'] for x in items), default=None), 'notice': '外围数据缺失时允许模拟盘继续交易，但交易记录必须标注缺失项。'}
        _external_market_cache = (time.time(), payload)
        return payload


def _previous_weekdays(day: date, count: int) -> list[date]:
    result: list[date] = []
    cursor = day
    while len(result) < count:
        cursor = cursor.fromordinal(cursor.toordinal() - 1)
        if cursor.weekday() < 5:
            result.append(cursor)
    return result


@router.get("/volume-forecast")
async def volume_forecast_for_symbol(
    request: Request,
    symbol: str = Query(..., pattern=r"^\d{6}\.(SH|SZ|SS|BJ)$"),
    trade_date: date | None = Query(None),
):
    """Read real TickFlow minute amount samples and forecast full-day turnover."""
    normalized = symbol.strip().upper().replace(".SS", ".SH")
    day = trade_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if day > datetime.now(ZoneInfo("Asia/Shanghai")).date():
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    capset = request.app.state.capabilities
    if not capset.has(Cap.KLINE_MINUTE_BY_SYMBOL):
        raise HTTPException(status_code=503, detail="分钟行情权限不可用")
    try:
        asset_type = request.app.state.repo.resolve_asset_type(normalized)
        days = [day, *_previous_weekdays(day, 5)]

        def load(selected: date) -> list[dict]:
            frame = fetch_minute_single(normalized, selected, asset_type=asset_type, capset=capset)
            return [{**row, "datetime": str(row["datetime"])} for row in frame.to_dicts()]

        rows = await asyncio.gather(*(asyncio.to_thread(load, selected) for selected in days))
        result = forecast_amount(rows[0], rows[1:])
        result["source"] = f"{selected_minute_source()}分钟成交额"
        return {"symbol": normalized, "trade_date": day.isoformat(), **result}
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"分钟成交额读取失败：{type(exc).__name__}") from exc


@router.get("/market-volume-forecast")
async def market_volume_forecast(request: Request, trade_date: date | None = Query(None)):
    """Forecast full-A turnover from the persisted real minute universe.

    This endpoint intentionally does not substitute index turnover, price change,
    or synthetic bars. Missing current-day or comparable historical partitions
    produce an explicit unavailable response.
    """
    selected = trade_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    while selected.weekday() >= 5:
        selected = selected.fromordinal(selected.toordinal() - 1)
    if selected > today:
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    repo = request.app.state.repo

    def load() -> tuple[list[dict], list[list[dict]], int, list[str]]:
        instruments = repo.get_instruments_asset("stock")
        symbols = [str(value) for value in instruments["symbol"].drop_nulls().to_list()] if not instruments.is_empty() else []
        if not symbols:
            return [], [], 0, []
        current_frame = repo.get_minute_batch(symbols, selected, asset_type="stock")
        current_rows = current_frame.to_dicts() if not current_frame.is_empty() else []
        historical: list[list[dict]] = []
        cursor = selected
        for _ in range(5):
            cursor = cursor.fromordinal(cursor.toordinal() - 1)
            while cursor.weekday() >= 5:
                cursor = cursor.fromordinal(cursor.toordinal() - 1)
            frame = repo.get_minute_batch(symbols, cursor, asset_type="stock")
            rows = frame.to_dicts() if not frame.is_empty() else []
            if rows:
                historical.append(rows)
        covered = len({str(row.get("symbol")) for row in current_rows if row.get("symbol")})
        return current_rows, historical, covered, symbols

    try:
        current_rows, historical, covered_symbols, symbols = await asyncio.to_thread(load)
        result = forecast_market_amount(current_rows, historical)
        result["source"] = f"{selected_minute_source()}全市场分钟分区"
        return {
            **result,
            "trade_date": selected.isoformat(),
            "scope": "全A股票（已落盘分钟分区）",
            "symbol_count": len(symbols),
            "covered_symbol_count": covered_symbols,
            "historical_days_available": len(historical),
            "data_is_real": True,
        }
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"全市场分钟成交额读取失败：{type(exc).__name__}") from exc


@router.post("/decision/assist")
async def decision_assist(request: Request):
    """Risk-first, explainable decision assistance; never places orders."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("请求体必须为 JSON 对象")
        risk_budget = float(payload.pop("risk_budget", 5000))
        # API callers must opt into an explicitly non-strict research preview;
        # the default decision path requires the full market context.
        payload.setdefault("strict_context", True)
        return build_decision(payload, risk_budget=risk_budget)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/ptrade/etf-minute/import")
async def ptrade_import(request: Request):
    """Authenticated, rate-limited CSV upload; never accepts broker credentials."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = [t for t in _ptrade_upload_times.get(ip, []) if now - t < 60]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="一分钟最多上传 5 次")
    recent.append(now)
    _ptrade_upload_times[ip] = recent
    if int(request.headers.get("content-length", "0") or "0") > 300_000:
        raise HTTPException(status_code=413, detail="CSV 超过 300 KB")
    raw = await request.body()
    try:
        result = await asyncio.to_thread(ptrade_replay.save_csv, settings.data_dir, raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", **result}


@router.post("/trades/import")
async def trades_import(request: Request):
    """Import broker/manual fills into the idempotent local transaction ledger."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = [t for t in _ptrade_upload_times.get(f"trades:{ip}", []) if now - t < 60]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="一分钟最多上传 5 次")
    recent.append(now)
    _ptrade_upload_times[f"trades:{ip}"] = recent
    if int(request.headers.get("content-length", "0") or "0") > 300_000:
        raise HTTPException(status_code=413, detail="成交 CSV 超过 300 KB")
    try:
        result = await asyncio.to_thread(ptrade_replay.save_trade_csv, settings.data_dir, await request.body())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", **result}


@router.get("/ptrade/etf-minute/replay")
async def ptrade_etf_replay(symbol: str = Query(...), trade_date: date | None = Query(None), source: str = Query("ptrade", pattern="^(ptrade|public)$")):
    symbol = symbol.strip().upper()
    if not __import__("re").fullmatch(r"\d{6}\.(SH|SZ|SS|BJ)", symbol):
        raise HTTPException(status_code=400, detail="证券代码格式必须为 6 位代码加交易所后缀")
    selected_date = trade_date or date.fromisoformat(ptrade_replay.TARGET_DAY)
    if source == "public":
        from app.api.indices import get_public_index_minute
        public_symbol = symbol.replace(".SS", ".SH")
        result = await get_public_index_minute(symbol=public_symbol, trade_date=selected_date)
        if result.get("display_date") != ptrade_replay.TARGET_DAY:
            return ptrade_replay.replay(symbol, [], trade_date=selected_date.isoformat())
        rows = [{"symbol": symbol, "datetime": row["datetime"].replace(" ", "T") + ":00+08:00",
                 "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"],
                 "volume": row["volume"] * 100, "amount": row["amount"], "source": "eastmoney_public_delayed"}
                for row in result["rows"] if row["datetime"][11:16] != "09:30"]
        return ptrade_replay.replay(symbol, rows, source="东方财富公开延迟行情（非PTrade）", trade_date=selected_date.isoformat(),
                                    trades=await asyncio.to_thread(ptrade_replay.load_trade_rows, settings.data_dir, symbol, selected_date.isoformat()))
    minute_rows = await asyncio.to_thread(ptrade_replay.load, settings.data_dir, symbol, selected_date.isoformat())
    trade_rows = await asyncio.to_thread(ptrade_replay.load_trade_rows, settings.data_dir, symbol, selected_date.isoformat())
    return ptrade_replay.replay(symbol, minute_rows, trade_date=selected_date.isoformat(), trades=trade_rows)


def _parse_flow(lines: list[str]) -> list[dict]:
    rows = []
    for line in lines:
        values = line.split(",")
        if len(values) < 6:
            continue
        try:
            rows.append({
                "time": values[0],
                "main": round(float(values[1]) / 1e8, 3),
                "small": round(float(values[2]) / 1e8, 3),
                "medium": round(float(values[3]) / 1e8, 3),
                "big": round(float(values[4]) / 1e8, 3),
                "super": round(float(values[5]) / 1e8, 3),
            })
        except ValueError:
            continue
    return rows


def _parse_price(lines: list[str], period: str) -> list[dict]:
    bars = []
    for line in lines:
        fields = line.split(",")
        if len(fields) < 7:
            continue
        try:
            date = fields[0]
            open_, close, high, low = (float(value) for value in fields[1:5])
            volume = float(fields[5])
            if not date.startswith("20") or min(open_, close, high, low) <= 0 or low > min(open_, close) or high < max(open_, close):
                continue
            bars.append({"time": date, "open": open_, "close": close, "high": high,
                         "low": low, "volume": volume,
                         "pct": float(fields[8]) if period == "daily" and len(fields) > 8 else None})
        except ValueError:
            continue
    return bars


def _sum_market_flows(sh: list[dict], sz: list[dict]) -> list[dict]:
    by_time: dict[str, dict] = {}
    for row in sh + sz:
        merged = by_time.setdefault(row["time"], {"time": row["time"],
            "main": 0, "super": 0, "big": 0, "medium": 0, "small": 0})
        for field in ("main", "super", "big", "medium", "small"):
            merged[field] += row[field]
    return [{field: round(value, 3) if field != "time" else value for field, value in by_time[day].items()}
            for day in sorted(by_time)]


async def _fetch_daily_flow(client: httpx.AsyncClient, secid: str, days: int) -> list[dict]:
    response = await client.get(_FLOW_HISTORY_URL, params={
        "lmt": str(days), "klt": "101", "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
        "secid": secid,
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0 or not (payload.get("data") or {}).get("klines"):
        raise ValueError(f"历史资金流接口未返回 {secid} 的数据")
    return _parse_flow(payload["data"]["klines"])


async def _fetch_board_price(client: httpx.AsyncClient, sector: str, period: str, days: int) -> tuple[str, list[dict]]:
    klt = {"daily": "101", "1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}[period]
    response = await client.get(_BOARD_KLINE_URL, params={
        "secid": f"90.{sector}", "klt": klt, "fqt": "0", "beg": "19900101" if period == "daily" else "0",
        "end": "20500101", "lmt": str(days if period == "daily" else 120),
        "fields1": "f1,f2,f3,f4,f5,f6", "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    })
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") or {}
    if payload.get("rc") != 0 or not data.get("klines"):
        raise ValueError(f"板块 {sector} 暂无{period}行情")
    bars = _parse_price(data["klines"], period)
    return str(data.get("name") or sector), bars[-days if period == "daily" else -120:]


async def _fetch_flow(client: httpx.AsyncClient, secid: str) -> list[dict]:
    response = await client.get(_FLOW_URL, params={
        "lmt": "0", "klt": "1", "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "ut": _FLOW_UT,
        "secid": secid,
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0 or not (payload.get("data") or {}).get("klines"):
        raise ValueError(f"资金流接口未返回 {secid} 的分时数据")
    return _parse_flow(payload["data"]["klines"])


async def _fetch_ranking(client: httpx.AsyncClient, descending: bool, limit: int = 100) -> list[dict]:
    response = await client.get(_RANK_URL, params={
        "fid": "f62", "po": "1" if descending else "0", "pz": str(limit),
        "pn": "1", "np": "1", "fltt": "2", "invt": "2", "ut": _FLOW_UT,
        "fs": "m:90+t:2", "fields": "f3,f12,f14,f62,f124",
    })
    response.raise_for_status()
    payload = response.json()
    if payload.get("rc") != 0:
        raise ValueError("板块资金榜暂不可用")
    items = (payload.get("data") or {}).get("diff") or []
    return [{
        "code": str(item.get("f12") or ""),
        "name": str(item.get("f14") or ""),
        "net_yi": round(float(item.get("f62") or 0) / 1e8, 3),
        "pct": item.get("f3"),
    } for item in items if item.get("f12") and item.get("f14")]


async def _fetch_board_catalog(client: httpx.AsyncClient) -> list[dict]:
    """Load Eastmoney industry/concept boards, not only the current top fund-flow ranks."""
    rows: dict[str, dict] = {}
    for page in range(1, 13):
        response = await client.get(_RANK_URL, params={
            "fid": "f3", "po": "1", "pz": "100", "pn": str(page), "np": "1",
            "fltt": "2", "invt": "2", "ut": _FLOW_UT,
            "fs": "m:90+t:2,m:90+t:3", "fields": "f3,f12,f14",
        })
        response.raise_for_status()
        payload = response.json()
        if payload.get("rc") != 0:
            raise ValueError("板块目录暂不可用")
        items = (payload.get("data") or {}).get("diff") or []
        for item in items:
            code, name = str(item.get("f12") or ""), str(item.get("f14") or "")
            if code.startswith("BK") and name:
                rows[code] = {"code": code, "name": name, "pct": item.get("f3")}
        if len(items) < 100:
            break
    return sorted((item for item in rows.values() if _is_linkable_board_name(item["name"])), key=lambda item: item["name"])


def _configured_fuyao_provider():
    """Return the configured Fuyao provider, without exposing credentials."""
    try:
        from app.data_providers import custom as custom_sources
        if not custom_sources.is_custom_provider("fuyao"):
            return None
        provider = custom_sources.get_provider("fuyao")
        return provider if hasattr(provider, "get_ths_index_catalog") else None
    except (ImportError, RuntimeError, TypeError, ValueError):
        return None


async def _fetch_fuyao_board_catalog() -> list[dict]:
    provider = _configured_fuyao_provider()
    if provider is None:
        return []
    rows: dict[str, dict] = {}
    for tag, kind in (("industry", "industry"), ("cn_concept", "concept")):
        items, _timestamp = await asyncio.to_thread(provider.get_ths_index_catalog, tag)
        for item in items:
            code = str(item.get("thscode") or "").strip().upper()
            name = str(item.get("name") or "").strip()
            if code and name and _is_linkable_board_name(name):
                rows[code] = {"code": code, "name": name, "type": kind, "pct": None}
    return sorted(rows.values(), key=lambda item: item["name"])


async def _fetch_fuyao_board_history(code: str, days: int) -> tuple[str, list[dict], int]:
    provider = _configured_fuyao_provider()
    if provider is None:
        raise ValueError("扶摇未配置或板块接口不可用")
    end = datetime.now(ZoneInfo("Asia/Shanghai"))
    start = end.fromtimestamp(end.timestamp() - 5 * 366 * 86400, tz=ZoneInfo("Asia/Shanghai"))
    raw, timestamp = await asyncio.to_thread(
        provider.get_ths_index_history, code, int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    )
    rows = []
    for row in raw:
        try:
            date_ms = int(row.get("date_ms") or 0)
            if not date_ms:
                continue
            moment = datetime.fromtimestamp(date_ms / 1000, tz=ZoneInfo("Asia/Shanghai"))
            rows.append({
                "time": moment.strftime("%Y-%m-%d"),
                "open": float(row["open_price"]), "close": float(row["close_price"]),
                "high": float(row["high_price"]), "low": float(row["low_price"]),
                "volume": float(row.get("volume") or 0),
                "amount": float(row.get("turnover") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return code, rows[-days:], timestamp


async def _fetch_local_index_history(request: Request, code: str, days: int) -> list[dict]:
    """Read an exchange index/ETF from the local TickFlow-routed daily store."""
    repo = request.app.state.repo
    asset_type = repo.resolve_asset_type(code)
    if asset_type not in {"index", "etf"}:
        asset_type = "index"
    end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    start = end - timedelta(days=5 * 366)
    frame = await asyncio.to_thread(repo.get_daily_asset, asset_type, code, start, end)
    if frame.is_empty():
        raise ValueError("本地没有该指数的TickFlow日K缓存")
    rows = []
    for row in frame.sort("date").tail(days).to_dicts():
        try:
            rows.append({
                "time": str(row["date"]), "open": float(row["open"]), "close": float(row["close"]),
                "high": float(row["high"]), "low": float(row["low"]),
                "volume": float(row.get("volume") or 0), "amount": float(row.get("amount") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    if not rows:
        raise ValueError("本地没有有效的TickFlow指数日K")
    return rows


@router.get("/fund-flow/sectors")
async def fund_flow_sectors(q: str = Query("", max_length=40), limit: int = Query(1200, ge=1, le=1200)):
    """Search THS industry/concept boards first, then fall back to Eastmoney BK boards."""
    global _fuyao_board_catalog_cache
    fuyao_cached = _fuyao_board_catalog_cache
    if not fuyao_cached or time.monotonic() - fuyao_cached[0] >= 1800:
        async with _fuyao_board_catalog_lock:
            fuyao_cached = _fuyao_board_catalog_cache
            if not fuyao_cached or time.monotonic() - fuyao_cached[0] >= 1800:
                try:
                    fuyao_items = await _fetch_fuyao_board_catalog()
                    if fuyao_items:
                        _fuyao_board_catalog_cache = (time.monotonic(), fuyao_items)
                        fuyao_cached = _fuyao_board_catalog_cache
                except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
                    logger.info("扶摇板块目录不可用，回退东方财富: %s", type(exc).__name__)
    if fuyao_cached:
        items = fuyao_cached[1]
        keyword = q.strip().casefold()
        if keyword:
            items = [item for item in items if _board_keyword_match(item, keyword)]
        return {"items": items[:limit], "total": len(items), "source": "扶摇同花顺行业/概念目录"}

    global _board_catalog_cache
    cached = _board_catalog_cache
    if not cached or time.monotonic() - cached[0] >= 600:
        async with _board_catalog_lock:
            cached = _board_catalog_cache
            if not cached or time.monotonic() - cached[0] >= 600:
                try:
                    async with httpx.AsyncClient(timeout=15.0) as client:
                        items = await _fetch_board_catalog(client)
                    _board_catalog_cache = (time.monotonic(), items)
                    cached = _board_catalog_cache
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                    if not cached:
                        raise HTTPException(status_code=502, detail=f"板块目录暂不可用：{type(exc).__name__}") from exc
    items = cached[1]
    keyword = q.strip().casefold()
    if keyword:
        items = [item for item in items if _board_keyword_match(item, keyword)]
    return {"items": items[:limit], "total": len(items), "source": "东方财富公开板块目录（扶摇不可用时兜底）"}


@router.get("/fund-flow/live")
async def fund_flow_live(sector: str | None = Query(None, pattern=r"^BK\d{4}$")):
    """东方财富公开延迟行情；60 秒轮询，返回原始数据时点供前端辨别新旧。"""
    key = sector or "market"
    cached = _flow_cache.get(key)
    if cached and time.monotonic() - cached[0] < 55:
        return cached[1]
    async with _flow_lock:
        cached = _flow_cache.get(key)
        if cached and time.monotonic() - cached[0] < 55:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                if sector:
                    rows = await _fetch_flow(client, f"90.{sector}")
                else:
                    sh, sz = await asyncio.gather(
                        _fetch_flow(client, "1.000001"),
                        _fetch_flow(client, "0.399001"),
                    )
                    rows = _sum_market_flows(sh, sz)
                rank_results = await asyncio.gather(
                    _fetch_ranking(client, True), _fetch_ranking(client, False),
                    return_exceptions=True,
                )
            if not rows:
                raise ValueError("资金流接口暂无分时数据")
            now = datetime.now(ZoneInfo("Asia/Shanghai"))
            latest = rows[-1]["time"]
            in_rank = rank_results[0] if isinstance(rank_results[0], list) else []
            out_rank = rank_results[1] if isinstance(rank_results[1], list) else []
            result = {
                "mode": "sector" if sector else "market", "sector": sector,
                "sector_name": next((x["name"] for x in in_rank + out_rank if x["code"] == sector), sector) if sector else None,
                "rows": rows,
                "latest_time": latest,
                "fetched_at": now.isoformat(timespec="seconds"),
                "is_today": latest[:10] == now.date().isoformat(),
                "stale": False,
                "source": "东方财富公开延迟资金流（push2delay）",
                "inflow": in_rank, "outflow": out_rank,
            }
            _flow_cache[key] = (time.monotonic(), result)
            if result["is_today"]:
                try:
                    await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir, key, rows, result["fetched_at"])
                except (OSError, ValueError, sqlite3.Error) as exc:
                    logger.warning("fund flow archive write failed: %s", exc)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"资金流数据暂不可用：{type(exc).__name__}") from exc


@router.get("/fund-flow/day")
async def fund_flow_day(
    date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    sector: str | None = Query(None, pattern=r"^BK\d{4}$"),
):
    """A past day's genuine archived minute curve, or today's live minute curve."""
    try:
        selected = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="交易日期格式不正确") from exc
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if selected > today:
        raise HTTPException(status_code=400, detail="不能查询未来日期")
    code = sector or "market"
    if selected == today:
        live = await fund_flow_live(sector=sector)
        if live["latest_time"][:10] == date:
            return {"status": "ok", "date": date, "sector": sector, "rows": live["rows"],
                    "latest_time": live["latest_time"], "fetched_at": live["fetched_at"],
                    "source": live["source"], "stale": live["stale"], "mode": live["mode"]}
    stored = await asyncio.to_thread(fund_flow_archive.load_day, settings.data_dir, code, date)
    if stored:
        return {"status": "ok", "date": date, "sector": sector, "rows": stored["rows"],
                "latest_time": stored["rows"][-1]["time"], "fetched_at": stored["fetched_at"],
                "source": "本机归档的东方财富分钟资金流", "stale": True,
                "mode": "sector" if sector else "market"}
    return {"status": "not_recorded", "date": date, "sector": sector, "rows": [],
            "notice": "该日没有归档的分钟资金记录；公开接口只提供最近交易日，无法从日终净额还原盘中曲线。"}


async def _archive_after_close() -> dict:
    """Once after close, retain market and the ranked industry boards for future day inspection."""
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    fetched_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    saved = 0
    async with httpx.AsyncClient(timeout=12.0) as client:
        sh, sz = await asyncio.gather(_fetch_flow(client, "1.000001"), _fetch_flow(client, "0.399001"))
        market_rows = _sum_market_flows(sh, sz)
        if market_rows and market_rows[-1]["time"][:10] == today:
            saved += int(await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir,
                                                   "market", market_rows, fetched_at))
        ranks = await asyncio.gather(_fetch_ranking(client, True, 16), _fetch_ranking(client, False, 16), return_exceptions=True)
        codes = list(dict.fromkeys(row["code"] for group in ranks if isinstance(group, list) for row in group))
        limit = asyncio.Semaphore(4)

        async def save_sector(code: str) -> int:
            async with limit:
                try:
                    rows = await _fetch_flow(client, f"90.{code}")
                    if rows and rows[-1]["time"][:10] == today:
                        return int(await asyncio.to_thread(fund_flow_archive.save_day, settings.data_dir,
                                                           code, rows, fetched_at))
                except (httpx.HTTPError, ValueError, OSError, sqlite3.Error) as exc:
                    logger.warning("fund flow archive skipped %s: %s", code, exc)
                return 0

        saved += sum(await asyncio.gather(*(save_sector(code) for code in codes)))
    return {"date": today, "saved_scopes": saved}


def archive_after_close() -> None:
    try:
        logger.info("fund flow archive: %s", asyncio.run(_archive_after_close()))
    except (httpx.HTTPError, ValueError, OSError, sqlite3.Error) as exc:
        logger.warning("fund flow archive failed: %s", exc)


@router.get("/fund-flow/history")
async def fund_flow_history(
    sector: str | None = Query(None, pattern=r"^BK\d{4}$"),
    days: int = Query(60, ge=10, le=120),
):
    """Completed daily fund-flow bars; the market series is Shanghai + Shenzhen by date."""
    key = f"flow:{sector or 'market'}:{days}"
    cached = _history_cache.get(key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    async with _history_lock:
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 600:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                if sector:
                    rows = await _fetch_daily_flow(client, f"90.{sector}", days)
                else:
                    sh, sz = await asyncio.gather(
                        _fetch_daily_flow(client, "1.000001", days),
                        _fetch_daily_flow(client, "0.399001", days),
                    )
                    rows = _sum_market_flows(sh, sz)
            if not rows:
                raise ValueError("暂无历史资金流数据")
            result = {"mode": "sector" if sector else "market", "sector": sector, "rows": rows[-days:],
                      "latest_time": rows[-1]["time"], "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "source": "东方财富历史日资金流", "unit": "亿元"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"历史资金流暂不可用：{type(exc).__name__}") from exc


@router.get("/fund-flow/sector-kline")
async def sector_kline(
    request: Request,
    sector: str = Query(..., pattern=r"^(?:BK\d{4}|\d{6}\.(?:TI|SH|SZ))$"),
    period: str = Query("daily", pattern=r"^(daily|1m|5m|15m|30m|60m)$"),
    days: int = Query(60, ge=10, le=120),
):
    """Use TickFlow-routed local bars for exchange indices, Fuyao for THS boards."""
    if re.fullmatch(r"\d{6}\.(?:SH|SZ)", sector.upper()):
        key = f"tickflow-kline:{sector}:{days}"
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        if period != "daily":
            raise HTTPException(status_code=503, detail="当前指数分钟板块曲线请使用指数行情组件；板块接口仅提供日K")
        try:
            rows = await _fetch_local_index_history(request, sector.upper(), days)
            result = {"sector": sector.upper(), "name": sector.upper(), "period": "daily", "rows": rows,
                      "latest_time": rows[-1]["time"],
                      "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "tickflow",
                      "source": "TickFlow日K缓存"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"TickFlow指数日K暂不可用：{type(exc).__name__}") from exc

    if re.fullmatch(r"\d{6}\.TI", sector.upper()):
        if period != "daily":
            raise HTTPException(status_code=503, detail="扶摇当前仅开放板块日K；板块分钟行情尚未开放外部接口")
        key = f"fuyao-kline:{sector}:{days}"
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        try:
            code, rows, timestamp = await _fetch_fuyao_board_history(sector.upper(), days)
            if not rows:
                raise ValueError("扶摇未返回该板块历史行情")
            result = {"sector": code, "name": code, "period": "daily", "rows": rows,
                      "latest_time": rows[-1]["time"],
                      "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "fuyao",
                      "source": "扶摇同花顺行业/概念指数日K", "server_timestamp": timestamp}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"扶摇板块日K暂不可用：{type(exc).__name__}") from exc

    key = f"kline:{sector}:{period}:{days if period == 'daily' else 120}"
    ttl = 45 if period != "daily" else 300
    cached = _history_cache.get(key)
    if cached and time.monotonic() - cached[0] < ttl:
        return cached[1]
    async with _history_lock:
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < ttl:
            return cached[1]
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                name, rows = await _fetch_board_price(client, sector, period, days)
            if not rows:
                raise ValueError("板块行情没有有效K线")
            result = {"sector": sector, "name": name, "period": period, "rows": rows,
                      "latest_time": rows[-1]["time"], "fetched_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                      "stale": False, "provider": "eastmoney",
                      "source": "东方财富公开板块行情（可能延迟）"}
            _history_cache[key] = (time.monotonic(), result)
            return result
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            if cached:
                return {**cached[1], "stale": True}
            raise HTTPException(status_code=502, detail=f"板块K线暂不可用：{type(exc).__name__}") from exc

@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_myagent(path: str, request: Request):
    if not (path.startswith("quant/") or path in {"chat", "config"}):
        return Response('{"detail":"Not Found"}', status_code=404, media_type="application/json")
    token = os.getenv("MYAGENT_ADMIN_TOKEN", "").strip()
    if not token:
        return Response('{"detail":"MyAgent bridge is not configured"}', status_code=503, media_type="application/json")
    query = str(request.url.query)
    base_url = os.getenv("MYAGENT_BRIDGE_URL", "http://myagent:8000").rstrip("/")
    url = f"{base_url}/api/{path}" + (f"?{query}" if query else "")
    body = await request.body()
    headers = {"X-Admin-Token": token}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.request(request.method, url, content=body, headers=headers)
        return Response(content=upstream.content, status_code=upstream.status_code,
                        media_type=upstream.headers.get("content-type", "application/json"))
    except httpx.HTTPError:
        return Response('{"detail":"MyAgent bridge unavailable"}', status_code=502, media_type="application/json")
