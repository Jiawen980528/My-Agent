import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const API = "/quant/api";
type Sector = { code?: string; name?: string; pct?: number; net_inflow?: number; amount?: number };
type Market = { limit?: { limit_up?: number; broken?: number; seal_rate?: number }; emotion?: { score?: number; label?: string } };
type Abnormal = { symbol: string; name?: string; change_pct?: number; consecutive_limit_ups?: number; signals?: string[] };
const pct = (value?: number) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%` : "—";
const tone = (value?: number) => Number(value) >= 0 ? "text-up" : "text-down";

export function StrongSectors() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [abnormal, setAbnormal] = useState<Abnormal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true); setError("");
    try {
      const [sectorResult, marketResult, abnormalResult] = await Promise.all([
        fetch(`${API}/myagent/fund-flow/sectors?limit=30`, { credentials: "include" }),
        fetch(`${API}/overview/market`, { credentials: "include" }),
        fetch(`${API}/abnormal/intraday?limit=100`, { credentials: "include" }),
      ]);
      const sectorBody = await sectorResult.json().catch(() => ({}));
      const marketBody = await marketResult.json().catch(() => ({}));
      const abnormalBody = await abnormalResult.json().catch(() => ({}));
      if (!sectorResult.ok) throw new Error(sectorBody.detail || "板块行情暂时无法读取");
      setSectors(Array.isArray(sectorBody.items) ? sectorBody.items : []);
      setMarket(marketResult.ok ? marketBody : null);
      setAbnormal(abnormalResult.ok && Array.isArray(abnormalBody.rows) ? abnormalBody.rows : []);
    } catch (e) {
      setSectors([]); setMarket(null); setAbnormal([]);
      setError(e instanceof Error ? e.message : "板块行情暂时无法读取");
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer); }, []);
  const leaders = useMemo(() => abnormal.filter(row => Number(row.consecutive_limit_ups || 0) >= 2 || row.signals?.includes("limit_up")).slice(0, 10), [abnormal]);
  const broken = useMemo(() => abnormal.filter(row => row.signals?.includes("broken")).slice(0, 10), [abnormal]);
  const guidance = useMemo(() => {
    const up = Number(market?.limit?.limit_up || 0); const brokenCount = Number(market?.limit?.broken || 0); const score = Number(market?.emotion?.score || 50);
    if (brokenCount >= Math.max(5, up * 0.4) || score < 40) return "炸板/情绪分歧偏大：强势板块只看龙头承接，禁止追后排；持仓冲高无量时优先降低风险。";
    if (score >= 70 && brokenCount < Math.max(3, up * 0.2)) return "情绪较强：可关注有资金、龙头未走弱的板块；优先回踩确认，不以高开本身作为追入理由。";
    return "轮动市：板块上涨不等于可追。等待龙头、量能和封板质量同步后再判断。";
  }, [market]);
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <section className="mb-3 rounded-card border border-border bg-surface p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-base font-semibold">强势板块</h1><p className="mt-1 text-xs text-muted">独立行情页：只分析板块、资金、龙头、连板与炸板，不执行拾贝筛选。</p></div><div className="flex gap-2"><button type="button" onClick={() => void load()} className="rounded-btn border border-accent/50 px-3 py-1.5 text-xs text-accent">{loading ? "读取中…" : "刷新"}</button><Link to="/pick-model" className="rounded-btn border border-border px-3 py-1.5 text-xs text-accent">进入拾贝模型</Link></div></div>{error && <p className="mt-3 rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">{error}</p>}</section>
    <section className="mb-3 grid gap-3 lg:grid-cols-3"><article className="rounded-card border border-border bg-surface p-3 lg:col-span-2"><h2 className="text-sm font-semibold">板块强度与资金流</h2><p className="mt-1 text-[11px] text-muted">资金字段未提供时只显示“—”，不以涨幅代替资金结论。</p><div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{sectors.map((sector, index) => <article key={sector.code || sector.name || index} className="rounded border border-border bg-base/50 p-2"><div className="flex justify-between gap-2 text-xs"><b>{index + 1}. {sector.name || sector.code}</b><span className={tone(sector.pct)}>{pct(sector.pct)}</span></div><div className="mt-1 text-[11px] text-muted">资金净流入：{sector.net_inflow == null ? "—" : Number(sector.net_inflow).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</div><div className="mt-1 text-[11px] text-muted">成交额：{sector.amount == null ? "—" : Number(sector.amount).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</div></article>)}{!sectors.length && !loading && <p className="text-xs text-muted">暂无可核验板块数据。</p>}</div></article><article className="rounded-card border border-accent/30 bg-accent/[0.04] p-3"><h2 className="text-sm font-semibold">板块操作指引</h2><p className="mt-2 text-xs leading-5 text-secondary">{guidance}</p><div className="mt-3 space-y-1 text-[11px] text-muted"><p>涨停 {market?.limit?.limit_up ?? "—"} · 炸板 {market?.limit?.broken ?? "—"}</p><p>封板率 {market?.limit?.seal_rate == null ? "—" : `${Number(market.limit.seal_rate).toFixed(0)}%`} · 情绪 {market?.emotion?.score ?? "—"}（{market?.emotion?.label || "待计算"}）</p></div><Link to="/market-board" className="mt-3 inline-block text-xs text-accent">查看全市场看盘 →</Link></article></section>
    <section className="grid gap-3 lg:grid-cols-2"><article className="rounded-card border border-border bg-surface p-3"><h2 className="text-sm font-semibold">龙头 / 连板观察</h2><p className="mt-1 text-[11px] text-muted">这里是全市场异动龙头，不能凭名称自动归属某板块。</p><div className="mt-2 space-y-1.5">{leaders.map(item => <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name || item.symbol)}`} className="flex justify-between rounded border border-border bg-base/50 px-2 py-1.5 text-xs hover:border-accent"><span><b>{item.name || item.symbol}</b><small className="ml-2 text-muted">{item.consecutive_limit_ups ? `${item.consecutive_limit_ups}连板` : "涨停异动"}</small></span><span className="text-up">{pct(item.change_pct)}</span></Link>)}{!leaders.length && <p className="text-xs text-muted">暂无可核验龙头异动。</p>}</div></article><article className="rounded-card border border-border bg-surface p-3"><h2 className="text-sm font-semibold">炸板风险</h2><p className="mt-1 text-[11px] text-muted">炸板增多时，板块上涨的可靠性下降，优先看龙头是否回封与量能承接。</p><div className="mt-2 space-y-1.5">{broken.map(item => <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name || item.symbol)}`} className="flex justify-between rounded border border-border bg-base/50 px-2 py-1.5 text-xs hover:border-warning"><span><b>{item.name || item.symbol}</b><small className="ml-2 text-warning">炸板</small></span><span className="text-down">{pct(item.change_pct)}</span></Link>)}{!broken.length && <p className="text-xs text-muted">暂无炸板异动。</p>}</div></article></section>
  </div>;
}
