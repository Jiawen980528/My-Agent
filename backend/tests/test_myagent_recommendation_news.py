"""Recommendation news evidence must remain bounded and inspectable."""

from app.api.myagent_bridge import (
    MYAGENT_PAPER_ACCOUNT_ID,
    _auto_execute_paper_candidate,
    _ensure_myagent_paper_account,
    _load_recommendations,
    _news_score_for_candidate,
    _remove_recommendation_record,
    _rotation_candidates,
    _save_recommendation_status,
)


def test_news_match_uses_pool_theme_and_caps_positive_score():
    row = {"symbol": "688001.SH", "name": "华兴源创"}
    pool = [{"symbol": "688001.SH", "name": "华兴源创", "theme": "物理AI", "segment": "机器视觉"}]
    news = [
        {"title": "物理AI产业链迎来新进展", "bias": "可能利好", "sector_names": ["物理AI"]},
        {"title": "机器视觉需求持续增长", "bias": "可能利好", "sector_names": []},
        {"title": "华兴源创披露新订单", "bias": "可能利好", "sector_names": []},
    ]

    score, detail = _news_score_for_candidate(row, pool, news)

    assert score == 10
    assert detail["matched_count"] == 3
    assert detail["positive_count"] == 3
    assert detail["status"] == "已匹配标题级公开新闻"


def test_news_non_match_is_not_silently_scored_as_positive():
    row = {"symbol": "000001.SZ", "name": "平安银行"}
    pool = [{"symbol": "000001.SZ", "name": "平安银行", "theme": "银行", "segment": ""}]
    news = [{"title": "半导体设备板块走强", "bias": "可能利好", "sector_names": ["半导体芯片"]}]

    score, detail = _news_score_for_candidate(row, pool, news)

    assert score == 0
    assert detail["matched_count"] == 0
    assert detail["status"] == "新闻源正常，但未命中该股/资料池主题"


def test_negative_headline_reduces_score_only_with_a_match():
    row = {"symbol": "000001.SZ", "name": "平安银行"}
    pool = [{"symbol": "000001.SZ", "name": "平安银行", "theme": "银行", "segment": ""}]
    news = [{"title": "平安银行收到监管问询", "bias": "可能利空", "sector_names": []}]

    score, detail = _news_score_for_candidate(row, pool, news)

    assert score == -5
    assert detail["negative_count"] == 1


def test_rotation_candidates_require_both_sector_membership_and_stock_signal():
    rows = [
        {"symbol": "688001.SH", "name": "华兴源创", "close": 20.0, "change_pct": 3.0,
         "vol_ratio_5d": 2.0, "signals": ["volume_surge"]},
        {"symbol": "000001.SZ", "name": "平安银行", "close": 10.0, "change_pct": 1.0,
         "vol_ratio_5d": 2.0, "signals": ["volume_surge"]},
    ]
    memberships = {"688001.SH": {"半导体设备"}, "000001.SZ": {"银行"}}

    result = _rotation_candidates(
        rows, memberships, ["半导体设备"], [], {"score": 60},
        {"market_flow_score": 0, "external_score": 0, "missing": []},
        {"items": [], "missing": []}, 0.4,
    )

    assert [item["symbol"] for item in result] == ["688001.SH"]
    assert result[0]["signals"][0] == "板块轮动"
    assert result[0]["score_detail"]["rotation_leaders"] == ["半导体设备"]
    assert result[0]["score_detail"]["rotation_index"] == 0.4


def test_no_candidate_status_is_visible_then_removed_by_real_snapshot(tmp_path):
    _save_recommendation_status(
        tmp_path, day="2026-11-17", stage="集合竞价", source="test",
        created_at="2026-11-17T09:20:00+08:00", reason="竞价数据不足",
    )
    rows = _load_recommendations(tmp_path)
    assert len(rows) == 1
    assert rows[0]["items"] == []
    assert "没有输出个股推荐" in rows[0]["model_status"]

    _remove_recommendation_record(tmp_path, "auto-集合竞价-status-2026-11-17")
    assert _load_recommendations(tmp_path) == []


def test_myagent_auto_paper_account_is_isolated_and_idempotent(tmp_path):
    first = _ensure_myagent_paper_account(tmp_path)
    again = _ensure_myagent_paper_account(tmp_path)

    assert first["id"] == MYAGENT_PAPER_ACCOUNT_ID
    assert first["name"] == "MyAgent 暗黑模拟盘"
    assert first["initial_cash"] == 100_000.0
    assert first["commission_pct"] == 0.000085
    assert first["max_tranches_per_symbol"] == 4
    assert again == first


def test_intraday_auto_recommendation_fills_at_visible_snapshot_price(tmp_path):
    result = _auto_execute_paper_candidate(tmp_path, {
        "date": "2026-11-18", "stage": "盘中推荐",
        "items": [{"symbol": "000001.SZ", "name": "测试股", "price": 10.0,
                   "score": 90, "eligible_for_paper": True}],
    })

    from app.strategy import paper
    order = paper.get_order(tmp_path, result["order_id"], MYAGENT_PAPER_ACCOUNT_ID)
    assert result["status"] == "submitted"
    assert result["order_type"] == "market"
    assert result["execution_status"] == "filled"
    assert order["status"] == "filled"
    assert order["fill_price"] > 10.0  # 买入滑点被计入，绝非事后收盘价回填


def test_auto_skip_explains_top_candidate_and_threshold(tmp_path):
    result = _auto_execute_paper_candidate(tmp_path, {
        "date": "2026-11-20", "stage": "盘中推荐",
        "items": [{"symbol": "000001.SZ", "name": "测试股", "price": 10.0,
                   "score": 72, "eligible_for_paper": True}],
    })

    assert result["status"] == "skipped"
    assert "000001.SZ 评分 72" in result["reason"]
    assert "低于自动门槛" in result["reason"]
    assert result["candidates"][0]["reason"].startswith("评分低于")
