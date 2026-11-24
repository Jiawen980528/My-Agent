import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Target } from 'lucide-react'

const API = '/quant/api/myagent/quant'
type Candidate = { symbol: string; name: string; sector?: string; price?: number; pct?: number; score?: number; priority?: string; entry_status?: string; pattern?: string; volume_multiple?: number; max_turnover?: number; latest_date?: string; quote_source?: string }
type ScanResult = { items?: Candidate[]; count?: number; universe_count?: number; data_source?: string; generated_at?: string; history_id?: number }
type Snapshot = { id: number | string; generated_at?: string; generatedAt?: string; period: string; valid_until?: string; validUntil?: string; scan_id?: number; historyId?: number; symbols: string[]; status: '待复盘' | '已复盘'; data_source?: string; payload?: Candidate[]; review?: { observations?: Array<{ observed_return_pct?: number | null }>; note?: string } | null }
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
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiReply, setAiReply] = useState('')
  const [aiSymbol, setAiSymbol] = useState('')
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState('')
  const [quoteNotice, setQuoteNotice] = useState('')
  useEffect(() => {
    fetch(`${API}/recommendation-snapshots?limit=20`, { credentials: 'include' })
      .then(async response => { const body = await response.json() as { items?: Snapshot[]; detail?: string }; if (!response.ok) throw new Error(body.detail || '推荐复盘记录读取失败'); return body })
      .then(body => setSnapshots(body.items || []))
      .catch(cause => setError(cause instanceof Error ? cause.message : '推荐复盘记录读取失败'))
  }, [])
  useEffect(() => {
    if (!result?.items?.length) return
    let disposed = false
    const refreshQuotes = async () => {
      try {
        const response = await fetch(`${API}/quotes?symbols=${result.items?.map(item => item.symbol).join(',')}`, { credentials: 'include' })
        const body = await response.json() as { items?: Array<{ code?: string; symbol?: string; price?: number; change_pct?: number; pct?: number }>; source?: string }
        if (!response.ok) throw new Error('实时行情暂不可用')
        const quotes = new Map((body.items || []).map(item => [String(item.code || item.symbol || '').replace(/\D/g, ''), item]))
        if (disposed) return
        setResult(current => current ? { ...current, items: (current.items || []).map(item => { const quote = quotes.get(item.symbol); return quote ? { ...item, price: quote.price, pct: quote.change_pct ?? quote.pct, quote_source: body.source } : item }) } : current)
        setQuoteUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        setQuoteNotice(body.source || '实时行情')
      } catch { if (!disposed) setQuoteNotice('实时行情暂不可用，显示扫描时数据') }
    }
    void refreshQuotes()
    const timer = window.setInterval(() => void refreshQuotes(), 30000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [result?.history_id])
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
  const reviewSummary = (snapshot: Snapshot) => {
    const values = (snapshot.review?.observations || []).map(item => Number(item.observed_return_pct)).filter(value => Number.isFinite(value))
    if (!values.length) return ''
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    const positive = values.filter(value => value > 0).length
    return `真实表现均值 ${average >= 0 ? '+' : ''}${average.toFixed(2)}% · 上涨 ${positive}/${values.length}`
  }
  const saveSnapshot = async () => {
    if (!result || !items.length) return
    const validUntil = period === '次日跟踪' ? '下一交易日收盘后' : period === '当日收盘' ? '今日收盘后' : '本次盘中观察结束'
    setError('')
    try {
      const response = await fetch(`${API}/recommendation-snapshots`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scan_id: result.history_id, period, valid_until: validUntil, generated_at: result.generated_at || new Date().toISOString(), data_source: result.data_source || '未标注', symbols: items.map(item => item.symbol), payload: items }) })
      const body = await response.json() as { detail?: string }
      if (!response.ok) throw new Error(body.detail || `保存失败 ${response.status}`)
      const refreshed = await fetch(`${API}/recommendation-snapshots?limit=20`, { credentials: 'include' })
      const list = await refreshed.json() as { items?: Snapshot[] }
      setSnapshots(list.items || [])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '推荐快照保存失败') }
  }
  const reviewSnapshot = async (snapshot: Snapshot) => {
    if (snapshot.status === '已复盘') return
    setError('')
    try {
      const quoteResponse = await fetch(`${API}/quotes?symbols=${snapshot.symbols.join(',')}`, { credentials: 'include' })
      const quoteBody = await quoteResponse.json() as { items?: Array<{ symbol?: string; code?: string; price?: number; change_pct?: number; pct?: number }>; source?: string; detail?: string }
      if (!quoteResponse.ok) throw new Error(quoteBody.detail || `实时行情读取失败 ${quoteResponse.status}`)
      const quotes = new Map((quoteBody.items || []).map(item => [String(item.code || item.symbol || '').replace(/\D/g, ''), item]))
      const observedAt = new Date().toISOString()
      const observations = snapshot.symbols.map(symbol => {
        const code = symbol.replace(/\D/g, '')
        const quote = quotes.get(code)
        const original = (snapshot.payload || []).find(item => item.symbol === code)
        const entry = Number(original?.price || 0)
        const current = Number(quote?.price || 0)
        return { symbol: code, name: original?.name || '', observed_price: current || null, reference_price: entry || null, observed_return_pct: entry > 0 && current > 0 ? Number(((current / entry - 1) * 100).toFixed(3)) : null, change_pct: quote?.change_pct ?? quote?.pct ?? null, observed_at: observedAt, source: quoteBody.source || '未标注' }
      })
      if (observations.every(item => item.observed_price == null)) throw new Error('当前没有读取到可用于复盘的真实行情，未改变快照状态')
      const response = await fetch(`${API}/recommendation-snapshots/${snapshot.id}/review`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observations, note: '使用复盘时刻真实行情记录表现；未将表现直接解释为策略命中率。' }) })
      const body = await response.json() as { detail?: string }
      if (!response.ok) throw new Error(body.detail || `复盘保存失败 ${response.status}`)
      setSnapshots(current => current.map(item => item.id === snapshot.id ? { ...item, status: '已复盘' } : item))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '推荐复盘失败') }
  }
  const askAI = async (item: Candidate) => {
    setAiLoading(true); setAiSymbol(item.symbol); setAiReply('')
    try {
      const response = await fetch(`${API}/ai`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: item.symbol, name: item.name, question: `请复核这只候选是否值得继续观察：重点说明大盘/板块/个股条件、当前缺失的数据、触发条件和失效条件，不要给出确定买卖指令。`, context: { candidate: item, recommendation_period: period, scan_generated_at: result?.generated_at || null, scan_source: result?.data_source || null } }) })
      const body = await response.json() as { reply?: string; detail?: string }
      if (!response.ok) throw new Error(body.detail || `AI复核失败 ${response.status}`)
      setAiReply(body.reply || 'AI没有返回可用文字。')
    } catch (cause) { setAiReply(cause instanceof Error ? cause.message : 'AI复核失败') } finally { setAiLoading(false) }
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
    {result && <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted"><span>生成于 {result.generated_at || '未标注'}</span><span>数据源：{result.data_source || '未标注'}</span><span>全市场样本 {result.universe_count ?? '—'} · 原始候选 {result.count ?? 0} · 展示 {items.length}/5</span>{result.history_id != null && <span>记录 #{result.history_id}</span>}{quoteUpdatedAt && <span>行情更新 {quoteUpdatedAt} · {quoteNotice}</span>}</div>}
    {(aiLoading || aiReply) && <div className="mb-3 rounded-card border border-accent/40 bg-accent/5 p-3"><div className="flex items-center justify-between gap-2 text-xs font-semibold">AI复核 · {aiSymbol}<span className="text-[10px] font-normal text-muted">研究辅助，不自动下单</span></div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-muted">{aiLoading ? '正在结合候选条件和当前可用数据分析…' : aiReply}</p></div>}
    <div className="mb-3 rounded-card border border-border bg-surface p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">推荐复盘</span><span className="text-muted">当前快照：{latestSnapshot ? `${latestSnapshot.period} · ${latestSnapshot.status}` : '尚未保存'}</span></div>
      <p className="mt-1 text-muted">保存后只记录当时的候选、生成时间和数据源；收盘或下一交易日再用真实行情核对，命中率不会在未复盘前提前计算。</p>
      {!!snapshots.length && <div className="mt-2 grid gap-1 text-muted">{snapshots.slice(0, 3).map(snapshot => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-1"><span>{snapshot.generated_at || snapshot.generatedAt || '—'} · {snapshot.period} · {snapshot.symbols.join('、')}{reviewSummary(snapshot) && <span className="ml-2 text-foreground">{reviewSummary(snapshot)}</span>}</span><span className="flex items-center gap-2">{snapshot.status} · 有效至 {snapshot.valid_until || snapshot.validUntil || '—'}{snapshot.status === '待复盘' && <button type="button" onClick={() => reviewSnapshot(snapshot)} className="rounded border border-accent/60 px-1.5 py-0.5 text-accent">用当前真实行情复盘</button>}</span></div>)}</div>}
    </div>
    {!result && !loading && <div className="rounded-card border border-dashed border-border bg-surface p-10 text-center text-xs text-muted">点击“生成今日候选”后才读取真实扫描结果。</div>}
    {result && !items.length && <div className="rounded-card border border-warning/30 bg-warning/5 p-6 text-center text-xs text-warning">当前没有满足条件的候选。请检查数据时间、TickFlow/公开行情权限和筛选条件；不会用虚构标的补足。</div>}
    {!!items.length && <div className="grid gap-2">{items.map((item, index) => <article key={item.symbol} className="rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><span className="mr-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">#{index + 1}</span><b>{item.name}</b><span className="ml-2 font-mono text-[11px] text-muted">{item.symbol}</span><div className="mt-1 text-[11px] text-muted">板块 {item.sector || '未识别'} · 生成日 {item.latest_date || '—'}</div></div><div className="text-right"><b className="font-mono">{item.price == null ? '—' : Number(item.price).toFixed(2)}</b><div className={Number(item.pct) >= 0 ? 'text-bull' : 'text-bear'}>{item.pct == null ? '—' : `${Number(item.pct) >= 0 ? '+' : ''}${Number(item.pct).toFixed(2)}%`}</div></div></div><div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span>评分 <b className="text-accent">{item.score ?? '—'}</b></span><span>优先级 <b>{item.priority || '—'}</b></span><span>阶段 <b>{item.entry_status || '—'}</b></span><span>放量 <b>{item.volume_multiple == null ? '—' : `${item.volume_multiple}x`}</b></span></div><p className="mt-2 text-[11px] text-muted">形态：{item.pattern || '未提供'}。技术候选需进一步核对板块、资金、情绪和个股数据；缺少确认项时只观察，不生成下单动作。</p><button type="button" onClick={() => askAI(item)} className="mt-2 rounded border border-accent/60 px-2 py-1 text-[11px] text-accent">AI复核这只候选</button></article>)}</div>}
  </div>
}
