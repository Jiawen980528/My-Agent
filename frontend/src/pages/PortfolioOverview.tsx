import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const QUANT_API = "/quant/api/myagent/quant";
const API = "/quant/api";

type Holding = {
  symbol: string;
  name: string;
  sector?: string;
  quantity: number;
  cost: number;
  price?: number;
  profit?: number;
  profit_pct?: number;
};

type RecommendationItem = {
  symbol: string;
  name: string;
  score?: number;
  price?: number;
  change_pct?: number;
  signals?: string[];
  eligible_for_paper?: boolean;
};

type Recommendation = {
  id: string;
  date: string;
  stage: string;
  createdAt?: string;
  source?: string;
  items?: RecommendationItem[];
  paper_auto?: {
    status?: string;
    reason?: string;
    score?: number;
    execution_status?: string;
  };
};

function chinaTradeDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function number(value?: number, digits = 2) {
  return Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
}

function percent(value?: number) {
  if (!Number.isFinite(Number(value))) return "—";
  const numeric = Number(value);
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

export function PortfolioOverview() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingSource, setHoldingSource] = useState("");
  const [rows, setRows] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [holdingsResponse, recommendationsResponse] = await Promise.all([
        fetch(`${QUANT_API}/holdings`, { credentials: "include" }),
        fetch(`${API}/myagent/recommendations`, { credentials: "include" }),
      ]);
      const ledger = holdingsResponse.ok ? await holdingsResponse.json() : { items: [] };
      const recommendationData = recommendationsResponse.ok
        ? await recommendationsResponse.json()
        : { items: [] };
      setHoldings(Array.isArray(ledger.items) ? ledger.items : []);
      setHoldingSource(ledger.source || "MyAgent 手动持仓底账");
      setRows(Array.isArray(recommendationData.items) ? recommendationData.items : []);
      if (!holdingsResponse.ok || !recommendationsResponse.ok) {
        setError("部分数据暂时未读到；可刷新重试，原有底账不会被修改。");
      }
    } catch {
      setError("暂时无法读取持仓或推荐记录，请刷新重试。");
      setHoldings([]);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const holdingSummary = useMemo(() => {
    const cost = holdings.reduce((total, item) => total + Number(item.quantity || 0) * Number(item.cost || 0), 0);
    const marketValue = holdings.reduce(
      (total, item) => total + Number(item.quantity || 0) * Number(item.price ?? item.cost ?? 0),
      0,
    );
    const pnl = holdings.reduce((total, item) => {
      if (Number.isFinite(Number(item.profit))) return total + Number(item.profit);
      return total + Number(item.quantity || 0) * (Number(item.price ?? item.cost) - Number(item.cost || 0));
    }, 0);
    return { cost, marketValue, pnl };
  }, [holdings]);

  const marketDay = chinaTradeDate();
  const availableDays = [...new Set(rows.map((row) => row.date).filter(Boolean))].sort().reverse();
  const shownDay = availableDays.includes(marketDay) ? marketDay : availableDays[0];
  const recommendations = shownDay ? rows.filter((row) => row.date === shownDay) : [];
  const itemCount = recommendations.reduce((total, row) => total + (row.items?.length || 0), 0);

  return (
    <div className="h-full overflow-auto bg-base p-3 text-foreground">
      <section className="mb-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">持仓与今日推荐</h1>
            <p className="mt-1 text-xs text-muted">
              持仓只来自你确认后的 MyAgent 底账，不连接券商；推荐记录由后端按中国交易日保存。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} className="rounded-btn border border-accent/50 px-3 py-1.5 text-xs text-accent">
              {loading ? "读取中…" : "刷新记录"}
            </button>
            <Link to="/myagent-quant?tab=holdings" className="rounded-btn bg-accent px-3 py-1.5 text-xs text-white">
              录入/修正持仓
            </Link>
          </div>
        </div>
        {error && <p className="mt-3 rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">{error}</p>}
      </section>

      <section className="mb-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">我的真实持仓 <span className="text-muted">({holdings.length} 只)</span></h2>
          <span className="text-[11px] text-muted">来源：{holdingSource || "读取中"}</span>
        </div>
        {holdings.length > 0 && (
          <div className="mb-2 grid gap-2 sm:grid-cols-3">
            <div className="rounded-card border border-border bg-surface p-3 text-xs"><span className="text-muted">持仓成本</span><b className="ml-2">¥{number(holdingSummary.cost)}</b></div>
            <div className="rounded-card border border-border bg-surface p-3 text-xs"><span className="text-muted">按现价估值</span><b className="ml-2">¥{number(holdingSummary.marketValue)}</b></div>
            <div className="rounded-card border border-border bg-surface p-3 text-xs"><span className="text-muted">累计浮盈亏</span><b className={`ml-2 ${holdingSummary.pnl >= 0 ? "text-up" : "text-down"}`}>¥{number(holdingSummary.pnl)}</b></div>
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {holdings.map((holding) => (
            <article key={holding.symbol} className="rounded-card border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <div><b className="text-sm">{holding.name}</b><p className="mt-0.5 text-[11px] text-muted">{holding.symbol} · {holding.sector || "未标注板块"}</p></div>
                <span className={Number(holding.profit_pct) >= 0 ? "text-up text-xs" : "text-down text-xs"}>{percent(holding.profit_pct)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-y-1.5 text-xs text-secondary">
                <span>数量 <b className="text-foreground">{number(holding.quantity, 0)}</b></span>
                <span>成本 <b className="text-foreground">{number(holding.cost, 3)}</b></span>
                <span>现价 <b className="text-foreground">{number(holding.price, 3)}</b></span>
                <span>浮盈亏 <b className={Number(holding.profit) >= 0 ? "text-up" : "text-down"}>{number(holding.profit)}</b></span>
              </div>
              <Link to={`/stock-analysis?symbol=${encodeURIComponent(holding.symbol)}&name=${encodeURIComponent(holding.name)}`} className="mt-3 inline-block text-xs text-accent">查看个股分析 →</Link>
            </article>
          ))}
        </div>
        {!loading && holdings.length === 0 && (
          <div className="rounded-card border border-warning/30 bg-warning/5 p-4 text-xs text-secondary">
            <b className="text-warning">还没有确认后的持仓底账</b>
            <p className="mt-1">请通过“录入/修正持仓”手动填写，或上传截图识别后确认数量和成本；不会读取或操作券商账户。</p>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">每日推荐 <span className="text-muted">({itemCount} 只)</span></h2>
            <p className="mt-0.5 text-[11px] text-muted">
              {shownDay ? (shownDay === marketDay ? `中国交易日 ${shownDay}` : `今日暂无记录，展示最近一次 ${shownDay}`) : "暂未生成推荐记录"}
            </p>
          </div>
          <Link to="/recommendations" className="text-xs text-accent">查看完整推荐、涨幅与复盘 →</Link>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {recommendations.map((row) => (
            <article key={row.id} className="rounded-card border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><b className="text-sm">{row.stage}</b><span className="ml-2 text-[11px] text-muted">{row.source || "后端推荐快照"}</span></div>
                {row.paper_auto && <span className="text-[11px] text-muted">模拟盘：{row.paper_auto.status || row.paper_auto.execution_status || "已评估"}</span>}
              </div>
              {row.items?.length ? (
                <div className="mt-3 space-y-2">
                  {row.items.map((item) => (
                    <div key={item.symbol} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs first:border-t-0 first:pt-0">
                      <div><b>{item.name}</b><span className="ml-2 text-muted">{item.symbol}</span><span className="ml-2 text-muted">评分 {item.score ?? "—"}</span></div>
                      <div className="text-right"><span>推荐价 {number(item.price, 3)}</span><span className={`ml-2 ${Number(item.change_pct) >= 0 ? "text-up" : "text-down"}`}>{percent(item.change_pct)}</span></div>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-3 text-xs text-muted">本时段未达到推荐门槛。{row.paper_auto?.reason ? ` ${row.paper_auto.reason}` : ""}</p>}
              {row.paper_auto?.reason && row.items?.length ? <p className="mt-2 text-[11px] text-muted">模拟盘判断：{row.paper_auto.reason}</p> : null}
            </article>
          ))}
        </div>
        {!loading && recommendations.length === 0 && (
          <div className="rounded-card border border-border bg-surface p-4 text-xs text-muted">当前尚无已保存的推荐快照。开盘后由后端定时任务写入集合竞价、盘中或轮动记录；这里会直接显示，不依赖浏览器本地日期。</div>
        )}
      </section>
    </div>
  );
}
