import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const API = "/quant/api";
const LIMIT = 5;
type ScoreDetail = { pool_match?: boolean; technical?: number; volume?: number; sentiment?: number; market_flow?: number; external?: number; news?: number; missing?: string[] };
type Item = { symbol: string; name: string; score?: number; price?: number; change_pct?: number; signals?: string[]; eligible_for_paper?: boolean; score_detail?: ScoreDetail };
type Row = { id: string; date: string; stage: string; createdAt?: string; items?: Item[]; paper_auto?: { reason?: string } };
type PoolItem = { symbol?: string | null; name?: string | null };
type Holding = { symbol?: string | null; name?: string | null };
type Quote = { symbol: string; price?: number };
type Pick = Item & { stage: string; paperReason?: string; repeatToday: number; repeatAll: number; poolMatched: boolean; holdingMatched: boolean };

const number = (v?: number) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : "—";
const percent = (v?: number | null) => Number.isFinite(Number(v)) ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "—";
const normalKey = (value?: string | null) => {
  const raw = String(value || "").trim().toUpperCase();
  return raw ? raw.replace(/\.(SH|SZ|BJ)$/i, "").replace(/^SH|^SZ|^BJ/, "").padStart(6, "0") : "";
};
const itemKey = (item: { symbol?: string | null; name?: string | null }) => normalKey(item.symbol) || String(item.name || "").trim();
const recommendationReturn = (entry?: number, current?: number) => {
  const base = Number(entry); const latest = Number(current);
  return Number.isFinite(base) && base > 0 && Number.isFinite(latest) && latest > 0 ? (latest / base - 1) * 100 : null;
};
function chinaDate() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = (t: string) => p.find(x => x.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
function actionHint(item: Pick) {
  const signals = item.signals || [];
  if (signals.some(x => /broken|炸板/i.test(x))) return "炸板分歧：不追高，先观察龙头承接";
  if (signals.some(x => /limit|new_high|涨停|新高/i.test(x))) return "强势异动：不追高，观察量能与板块承接";
  if (item.eligible_for_paper && Number(item.score) >= 80) return "候选较强：等待回踩或放量确认";
  return "观察候选：等待价格、量能与情绪共同确认";
}

export function TodayRecommendations() {
  const [rows, setRows] = useState<Row[]>([]);
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const [recommendationResult, poolResult, holdingResult] = await Promise.allSettled([
        fetch(`${API}/myagent/recommendations`, { credentials: "include" }),
        fetch(`${API}/myagent/research-pool`, { credentials: "include" }),
        fetch(`${API}/myagent/quant/holdings`, { credentials: "include" }),
      ]);
      if (recommendationResult.status !== "fulfilled") throw new Error("推荐记录暂时无法读取");
      const recommendationBody = await recommendationResult.value.json().catch(() => ({}));
      if (!recommendationResult.value.ok) throw new Error(recommendationBody.detail || "推荐记录暂时无法读取");
      const nextRows = Array.isArray(recommendationBody.items) ? recommendationBody.items : [];
      setRows(nextRows);
      if (poolResult.status === "fulfilled" && poolResult.value.ok) {
        const body = await poolResult.value.json().catch(() => ({})); setPool(Array.isArray(body.items) ? body.items : []);
      } else setPool([]);
      if (holdingResult.status === "fulfilled" && holdingResult.value.ok) {
        const body = await holdingResult.value.json().catch(() => ({})); setHoldings(Array.isArray(body.items) ? body.items : []);
      } else setHoldings([]);
      const symbols = [...new Set(nextRows.flatMap((row: Row) => row.items || []).map((item: Item) => item.symbol).filter(Boolean))].join(",");
      if (!symbols) { setQuotes({}); return; }
      const quoteResult = await fetch(`${API}/myagent/quant/quotes?symbols=${encodeURIComponent(symbols)}`, { credentials: "include" });
      const quoteBody = await quoteResult.json().catch(() => ({}));
      setQuotes(quoteResult.ok ? Object.fromEntries((quoteBody.items || []).map((item: Quote) => [item.symbol, item])) : {});
    } catch (e) {
      setRows([]); setPool([]); setHoldings([]); setQuotes({});
      setError(e instanceof Error ? e.message : "推荐记录暂时无法读取");
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const today = chinaDate();
  const dates = [...new Set(rows.map(x => x.date).filter(Boolean))].sort().reverse();
  const shown = dates.includes(today) ? today : dates[0];
  const snapshots = shown ? rows.filter(x => x.date === shown) : [];
  const poolKeys = useMemo(() => new Set(pool.flatMap(item => [itemKey(item), String(item.name || "").trim()]).filter(Boolean)), [pool]);
  const holdingKeys = useMemo(() => new Set(holdings.flatMap(item => [itemKey(item), String(item.name || "").trim()]).filter(Boolean)), [holdings]);
  const picks = useMemo(() => {
    const todayCount = new Map<string, number>(); const allCount = new Map<string, number>();
    rows.forEach(row => (row.items || []).forEach(item => {
      const key = itemKey(item); if (!key) return;
      allCount.set(key, (allCount.get(key) || 0) + 1);
      if (row.date === shown) todayCount.set(key, (todayCount.get(key) || 0) + 1);
    }));
    const latest = new Map<string, Pick>();
    [...snapshots].sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id))).forEach(row => (row.items || []).forEach(item => {
      const key = itemKey(item); if (!key || latest.has(key)) return;
      const nameKey = String(item.name || "").trim();
      latest.set(key, { ...item, stage: row.stage, paperReason: row.paper_auto?.reason, repeatToday: todayCount.get(key) || 0, repeatAll: allCount.get(key) || 0, poolMatched: poolKeys.has(key) || (!!nameKey && poolKeys.has(nameKey)) || item.score_detail?.pool_match === true, holdingMatched: holdingKeys.has(key) || (!!nameKey && holdingKeys.has(nameKey)) });
    }));
    return [...latest.values()].sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1)).slice(0, LIMIT);
  }, [rows, snapshots, shown, poolKeys, holdingKeys]);

  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <section className="mb-3 rounded-card border border-border bg-surface p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-base font-semibold">今日推荐</h1><p className="mt-1 text-xs text-muted">最终候选严格最多 {LIMIT} 只。集合竞价、盘中、轮动只保留过程记录，不在这里重复塞入同一只股票。</p></div><div className="flex gap-2"><button type="button" onClick={() => void load()} className="rounded-btn border border-accent/50 px-3 py-1.5 text-xs text-accent">{loading ? "读取中…" : "刷新推荐"}</button><Link to="/recommendation-history" className="rounded-btn border border-border px-3 py-1.5 text-xs text-accent">推荐记录与复盘</Link></div></div>{error && <p className="mt-3 rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">{error}</p>}</section>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold">最终候选 <span className="text-muted">({picks.length}/{LIMIT} 只)</span></h2><p className="mt-0.5 text-[11px] text-muted">{shown ? (shown === today ? `中国交易日 ${shown}` : `今日暂无记录，展示最近一次 ${shown}`) : "暂无推荐记录"}</p></div><span className="text-[11px] text-muted">价格联动失败时会明确显示，不把推荐时涨跌当作推荐后收益</span></div>
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{picks.map((item, index) => {
      const current = quotes[item.symbol]?.price; const after = recommendationReturn(item.price, current);
      const missingFunds = item.score_detail?.missing?.some(x => /资金/.test(x));
      return <article key={itemKey(item)} className="rounded-card border border-border bg-surface p-3"><div className="flex items-start justify-between gap-2"><div><span className="mr-2 text-xs text-muted">#{index + 1}</span><b className="text-sm">{item.name}</b><p className="mt-0.5 text-[11px] text-muted">{item.symbol} · {item.stage}</p></div><span className="text-xs text-accent">评分 {item.score ?? "—"}</span></div>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">{item.poolMatched ? <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">股票池匹配</span> : <span className="rounded bg-muted/10 px-1.5 py-0.5 text-muted">非股票池</span>}{item.holdingMatched && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">影响我的持仓</span>}<span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-sky-300">今日第 {item.repeatToday} 次</span>{item.repeatAll > item.repeatToday && <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-sky-300">累计 {item.repeatAll} 次</span>}</div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-secondary"><span>推荐价 <b className="text-foreground">{number(item.price)}</b></span><span>当前价 <b className="text-foreground">{number(current)}</b></span><span>推荐时涨跌 <b className={Number(item.change_pct) >= 0 ? "text-up" : "text-down"}>{percent(item.change_pct)}</b></span><span>推荐后表现 <b className={after != null && after >= 0 ? "text-up" : "text-down"}>{percent(after)}</b></span></div>
        <p className="mt-2 text-[11px] text-secondary">操作提示：{actionHint(item)}</p>{item.signals?.length ? <p className="mt-2 text-[11px] text-muted">信号：{item.signals.slice(0, 3).join(" · ")}</p> : null}{missingFunds && <p className="mt-1 text-[11px] text-warning">资金流数据缺失：该候选不因缺失而伪造资金结论。</p>}{item.paperReason ? <p className="mt-1 text-[11px] text-muted">模拟盘：{item.paperReason}</p> : null}
        <details className="mt-2 text-[11px] text-muted"><summary className="cursor-pointer text-accent">查看多维评分与数据状态</summary><p className="mt-1 leading-5">技术 {number(item.score_detail?.technical)} · 量能 {number(item.score_detail?.volume)} · 情绪 {number(item.score_detail?.sentiment)} · 资金 {number(item.score_detail?.market_flow)} · 外围 {number(item.score_detail?.external)} · 新闻 {number(item.score_detail?.news)}{item.score_detail?.missing?.length ? ` · 缺失：${item.score_detail.missing.join("、")}` : ""}</p></details>
        <Link to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name)}`} className="mt-3 inline-block text-xs text-accent">详细分析 →</Link></article>;
    })}</div>
    {!loading && !picks.length && <div className="rounded-card border border-border bg-surface p-4 text-xs text-muted">当前没有达到最终候选标准的股票。完整的集合竞价、盘中与轮动快照请查看“推荐记录与复盘”。</div>}
  </div>;
}
