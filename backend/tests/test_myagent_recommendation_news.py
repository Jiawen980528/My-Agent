"""Recommendation news evidence must remain bounded and inspectable."""

from app.api.myagent_bridge import _news_score_for_candidate


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
