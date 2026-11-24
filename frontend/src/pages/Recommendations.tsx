import { useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Target } from 'lucide-react'

const API = '/quant/api/myagent/quant'
type Candidate = { symbol: string; name: string; sector?: string; price?: number; pct?: number; score?: number; priority?: string; entry_status?: string; pattern?: string; volume_multiple?: number; max_turnover?: number; latest_date?: string }
type ScanResult = { items?: Candidate[]; count?: number; universe_count?: number; data_source?: string; generated_at?: string; history_id?: number }
type Snapshot = { id: string; generatedAt: string; period: string; validUntil: string; historyId?: number; symbols: string[]; status: '待复盘' | '已复盘' }

const SNAPSHOT_KEY = 'myagent-recommendation-snapshots-v1'
const periodOptions = [
  { value: '盘中观察', label: '盘中观察', hint: '只用于当前交易时段的观察，不代表收盘预测' },
  { value: '当日收盘', label: '当日收盘', hint: '等待收盘数据后复盘当天表现' },
  { value: '次日跟踪', label: '次日跟踪', hint: '记录候选，下一交易日再核对，不自动下单' },
]

export function Recommendations() {
  const [result, setResult] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState('盘中观察')
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() => {
    try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '[]') as Snapshot[] } catch { return [] }
  })
  const [criteria, setCriteria] = useState({ baseline_days: 60, max_avg_turnover: 1.5, recent_days: 5, volume_multiple: 2, max_market_cap_yi: 100 })
  const scan = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch(`${API}/scan`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...criteria, force: true }) })
      const body = await response.json() as ScanResult & { detail?: string }
      if (!response.ok) throw new Error(body.detail || `扫描失败 ${response.status}`)
      setResult(body)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '扫描失败') } finally { setLoading(false) }
  }
  const items = useMemo(() => [...(result?.items || [])].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5), [result])
  const selectedPeriod = periodOptions.find(item => item.value === period) || periodOptions[0]
  const latestSnapshot = snapshots[0]
  const saveSnapshot = () => {
    if (!result || !items.length) return
    const now = new Date()
    const validUntil = period === '次日跟踪' ? '下一交易日收盘后' : period === '当日收盘' ? '今日收盘后' : '本次盘中观察结束'
    const snapshot: Snapshot = { id: `${now.getTime()}`, generatedAt: result.generated_at || now.toISOString(), period, validUntil, historyId: result.history_id, symbols: items.map(item => item.symbol), status: '待复盘' }
    const next = [snapshot, ...snapshots].slice(0, 20)
    setSnapshots(next); localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next))
  }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-3">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><Target className="h-4 w-4 text-accent" />今日推荐 · 规则候选</div><p className="mt-1 text-[11px] text-muted">最多展示 5 只。它是可追溯的研究候选，不是几分钟后或全天必然走势，也不会自动下单。</p></div>
      <button type="button" onClick={scan} disabled={loading} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? '扫描中…' : '生成今日候选'}</button>
    </div>
    <div className="mb-3 grid gap-3 rounded-card border border-border bg-surface p-3 md:grid-cols-[1fr_auto]">
      <div><div className="text-xs font-semibold">本次推荐周期</div><div className="mt-2 flex flex-wrap gap-2">{periodOptions.map(option => <button key={option.value} type="button" onClick={() => setPeriod(option.value)} className={`rounded border px-2.5 py-1.5 text-[11px] ${period === option.value ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted'}`}>{option.label}</button>)}</div><p className="mt-2 text-[11px] text-muted">{selectedPeriod.hint}；扫描算法本身不会把候选伪装成价格预测。</p></div>
      <div className="flex items-end"><button type="button" onClick={saveSnapshot} disabled={!result || !items.length} className="rounded-btn border border-accent/60 px-3 py-2 text-xs text-accent disabled:opacity-40">保存推荐快照</button></div>
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 md:grid-cols-5">{([['baseline_days','长期地量天数'],['max_avg_turnover','换手上限%'],['recent_days','异动窗口天数'],['volume_multiple','放量倍数'],['max_market_cap_yi','市值上限亿']] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-[11px] text-muted">{label}<input type="number" value={criteria[key]} onChange={e => setCriteria({ ...criteria, [key]: Number(e.target.value) })} className="h-8 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label>)}</div>
    {error && <div className="mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {result && <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted"><span>生成于 {result.generated_at || '未标注'}</span><span>数据源：{result.data_source || '未标注'}</span><span>全市场样本 {result.universe_count ?? '—'} · 原始候选 {result.count ?? 0} · 展示 {items.length}/5</span>{result.history_id != null && <span>记录 #{result.history_id}</span>}</div>}
    <div className="mb-3 rounded-card border border-border bg-surface p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">推荐复盘</span><span className="text-muted">当前快照：{latestSnapshot ? `${latestSnapshot.period} · ${latestSnapshot.status}` : '尚未保存'}</span></div>
      <p className="mt-1 text-muted">保存后只记录当时的候选、生成时间和数据源；收盘或下一交易日再用真实行情核对，命中率不会在未复盘前提前计算。</p>
      {!!snapshots.length && <div className="mt-2 grid gap-1 text-muted">{snapshots.slice(0, 3).map(snapshot => <div key={snapshot.id} className="flex flex-wrap justify-between gap-2 border-t border-border/60 pt-1"><span>{snapshot.generatedAt} · {snapshot.period} · {snapshot.symbols.join('、')}</span><span>{snapshot.status} · 有效至 {snapshot.validUntil}</span></div>)}</div>}
    </div>
    {!result && !loading && <div className="rounded-card border border-dashed border-border bg-surface p-10 text-center text-xs text-muted">点击“生成今日候选”后才读取真实扫描结果。</div>}
    {result && !items.length && <div className="rounded-card border border-warning/30 bg-warning/5 p-6 text-center text-xs text-warning">当前没有满足条件的候选。请检查数据时间、TickFlow/公开行情权限和筛选条件；不会用虚构标的补足。</div>}
    {!!items.length && <div className="grid gap-2">{items.map((item, index) => <article key={item.symbol} className="rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><span className="mr-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">#{index + 1}</span><b>{item.name}</b><span className="ml-2 font-mono text-[11px] text-muted">{item.symbol}</span><div className="mt-1 text-[11px] text-muted">板块 {item.sector || '未识别'} · 生成日 {item.latest_date || '—'}</div></div><div className="text-right"><b className="font-mono">{item.price == null ? '—' : Number(item.price).toFixed(2)}</b><div className={Number(item.pct) >= 0 ? 'text-bull' : 'text-bear'}>{item.pct == null ? '—' : `${Number(item.pct) >= 0 ? '+' : ''}${Number(item.pct).toFixed(2)}%`}</div></div></div><div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span>评分 <b className="text-accent">{item.score ?? '—'}</b></span><span>优先级 <b>{item.priority || '—'}</b></span><span>阶段 <b>{item.entry_status || '—'}</b></span><span>放量 <b>{item.volume_multiple == null ? '—' : `${item.volume_multiple}x`}</b></span></div><p className="mt-2 text-[11px] text-muted">形态：{item.pattern || '未提供'}。技术候选需进一步核对板块、资金、情绪和个股数据；缺少确认项时只观察，不生成下单动作。</p></article>)}</div>}
  </div>
}
