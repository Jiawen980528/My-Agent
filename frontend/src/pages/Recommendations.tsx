import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Target } from 'lucide-react'
import { Link } from 'react-router-dom'

const API = '/quant/api/myagent/quant'
const MYAGENT_ROOT = '/quant/api/myagent'
type Candidate = { symbol: string; name: string; sector?: string; price?: number; pct?: number; score?: number; priority?: string; entry_status?: string; pattern?: string; volume_multiple?: number; max_turnover?: number; latest_date?: string; quote_source?: string; reasons?: string[]; opposing_evidence?: string[] }
type HoldingLink = { symbol?: string; name?: string; sector?: string; quantity?: number; cost?: number }
type WatchLink = { symbol?: string; name?: string; sector?: string }
type PoolLink = { name?: string; status?: string; config?: { symbols?: unknown } }
type LotLink = { symbol?: string; qty?: number; cost_price?: number }
type TickflowStatus = { connected?: boolean; source?: string; message?: string }
type AIStatus = { api_key_configured?: boolean; model?: string; providers?: Array<{ label?: string; configured?: boolean }> }
type LegacySummary = {
  available?: boolean
  label?: string
  recommendations?: { records?: number; latest?: Array<{ date?: string; created_at?: string; stage?: string; source?: string; item_count?: number; paper_status?: string; paper_symbol?: string | null }>; paper_status?: Record<string, number>; paper_symbols?: number }
  reviews?: { days?: number; summary?: Array<{ date?: string; tracked?: number; wins?: number; win_rate?: number; average_pct?: number; best_pct?: number; worst_pct?: number }> }
  research_pool?: { items?: number; sources?: Array<[string, number]>; themes?: Array<[string, number]> }
  ai_reports?: { count?: number; symbols?: string[] }
  warnings?: string[]
}
type ScanResult = { items?: Candidate[]; count?: number; universe_count?: number; data_source?: string; generated_at?: string; history_id?: number }
type Snapshot = { id: number | string; generated_at?: string; generatedAt?: string; period: string; valid_until?: string; validUntil?: string; scan_id?: number; historyId?: number; symbols: string[]; status: '待复盘' | '已复盘'; data_source?: string; payload?: Candidate[]; review?: { observations?: Array<{ observed_return_pct?: number | null }>; note?: string } | null }
const periodOptions = [
  { value: '盘中观察', label: '盘中观察', hint: '只用于当前交易时段的观察，不代表收盘预测' },
  { value: '当日收盘', label: '当日收盘', hint: '等待收盘数据后复盘当天表现' },
  { value: '次日跟踪', label: '次日跟踪', hint: '记录候选，下一交易日再核对，不自动下单' },
]

function actionFor(item: Candidate) {
  switch (item.entry_status) {
    case '回踩观察': return { label: '观察回踩确认', detail: '回到均线附近且缩量、板块不转弱后再复核；不追高。', invalid: '放量跌破支撑或板块同步转弱' }
    case '等待回踩': return { label: '等待，不追高', detail: '异动刚发生，等价格和分时均线重新确认。', invalid: '继续冲高但量价背离' }
    case '均线附近': return { label: '继续观察', detail: '只说明价格接近均线，不等于买入条件成立。', invalid: '有效跌破均线且成交放大' }
    case '持续跟踪': return { label: '跟踪，不操作', detail: '保留在观察池，等待板块和资金确认。', invalid: '板块相对强度转弱' }
    default: return { label: '暂不操作', detail: '当前只有初筛结果，缺少进场确认。', invalid: '数据源失效或样本过期' }
  }
}

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
  const [holdings, setHoldings] = useState<HoldingLink[]>([])
  const [watchlist, setWatchlist] = useState<WatchLink[]>([])
  const [researchPools, setResearchPools] = useState<PoolLink[]>([])
  const [lots, setLots] = useState<LotLink[]>([])
  const [linkNotice, setLinkNotice] = useState('正在读取持仓、自选、持仓提醒与研究候选池…')
  const [tickflowStatus, setTickflowStatus] = useState<TickflowStatus | null>(null)
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null)
  const [legacySummary, setLegacySummary] = useState<LegacySummary | null>(null)
  useEffect(() => {
    fetch(`${API}/tickflow/status`, { credentials: 'include' })
      .then(async response => { const body = await response.json() as TickflowStatus; if (!response.ok) throw new Error('TickFlow状态读取失败'); return body })
      .then(setTickflowStatus)
      .catch(() => setTickflowStatus({ connected: false, message: 'TickFlow状态暂不可用' }))
  }, [])
  useEffect(() => {
    fetch(`${API}/legacy-summary`, { credentials: 'include' })
      .then(async response => { const body = await response.json() as LegacySummary; if (!response.ok) throw new Error('历史归档读取失败'); return body })
      .then(setLegacySummary)
      .catch(() => setLegacySummary(null))
  }, [])
  useEffect(() => {
    fetch(`${MYAGENT_ROOT}/config`, { credentials: 'include' })
      .then(async response => { const body = await response.json() as AIStatus; if (!response.ok) throw new Error('AI状态读取失败'); return body })
      .then(setAiStatus)
      .catch(() => setAiStatus({ api_key_configured: false }))
  }, [])
  useEffect(() => {
    let disposed = false
    const loadLinks = async () => {
      const [holdingResult, watchResult, poolResult, lotResult] = await Promise.allSettled([
        fetch(`${API}/holdings`, { credentials: 'include' }).then(async response => { const body = await response.json() as { items?: HoldingLink[]; detail?: string }; if (!response.ok) throw new Error(body.detail || '持仓读取失败'); return body.items || [] }),
        fetch('/api/watchlist', { credentials: 'include' }).then(async response => { const body = await response.json() as { symbols?: WatchLink[]; detail?: string }; if (!response.ok) throw new Error(body.detail || '自选读取失败'); return body.symbols || [] }),
        fetch('/api/backtest/candidates', { credentials: 'include' }).then(async response => { const body = await response.json() as { items?: PoolLink[]; detail?: string }; if (!response.ok) throw new Error(body.detail || '研究候选池读取失败'); return body.items || [] }),
        fetch('/api/lots', { credentials: 'include' }).then(async response => { const body = await response.json() as { lots?: LotLink[]; detail?: string }; if (!response.ok) throw new Error(body.detail || '持仓提醒读取失败'); return body.lots || [] }),
      ])
      if (disposed) return
      const holdingItems = holdingResult.status === 'fulfilled' ? holdingResult.value : []
      const watchItems = watchResult.status === 'fulfilled' ? watchResult.value : []
      const poolItems = poolResult.status === 'fulfilled' ? poolResult.value : []
      const lotItems = lotResult.status === 'fulfilled' ? lotResult.value : []
      setHoldings(holdingItems); setWatchlist(watchItems); setResearchPools(poolItems); setLots(lotItems)
      const notices = [holdingResult.status === 'fulfilled' ? `持仓 ${holdingItems.length} 条` : '持仓不可用', lotResult.status === 'fulfilled' ? `提醒批次 ${lotItems.length} 条` : '提醒批次不可用', watchResult.status === 'fulfilled' ? `自选 ${watchItems.length} 条` : '自选不可用', poolResult.status === 'fulfilled' ? `研究候选池 ${poolItems.length} 条` : '研究候选池不可用']
      setLinkNotice(notices.join(' · '))
    }
    void loadLinks()
    return () => { disposed = true }
  }, [])
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
        const normalize = (value: string) => value.replace(/\D/g, '').slice(-6)
        setResult(current => current ? { ...current, items: (current.items || []).map(item => { const quote = quotes.get(normalize(item.symbol)); return quote ? { ...item, price: quote.price, pct: quote.change_pct ?? quote.pct, quote_source: body.source } : item }) } : current)
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
  const normalizeCode = (value?: string) => String(value || '').replace(/\D/g, '').slice(-6)
  const linkFor = (item: Candidate) => {
    const code = normalizeCode(item.symbol)
    const holdingMatches = holdings.filter(row => normalizeCode(row.symbol) === code)
    const watchMatches = watchlist.filter(row => normalizeCode(row.symbol) === code)
    const sector = String(item.sector || '').trim()
    const sectorMatches = sector ? holdings.filter(row => String(row.sector || '').trim() === sector) : []
    const poolMatches = researchPools.filter(pool => Array.isArray(pool.config?.symbols) && (pool.config?.symbols as unknown[]).some(symbol => normalizeCode(String(symbol)) === code))
    const lotMatches = lots.filter(row => normalizeCode(row.symbol) === code)
    return { holdingMatches, watchMatches, sectorMatches, poolMatches, lotMatches }
  }
  const linkStats = useMemo(() => {
    const linked = items.map(item => linkFor(item))
    return {
      holdings: linked.filter(row => row.holdingMatches.length > 0).length,
      pools: linked.filter(row => row.poolMatches.length > 0).length,
      watchlist: linked.filter(row => row.watchMatches.length > 0).length,
      sectors: linked.filter(row => row.sectorMatches.length > 0).length,
      lots: linked.filter(row => row.lotMatches.length > 0).length,
    }
  }, [items, holdings, watchlist, researchPools, lots])
  const selectedPeriod = periodOptions.find(item => item.value === period) || periodOptions[0]
  const latestSnapshot = snapshots[0]
  const reviewSummary = (snapshot: Snapshot) => {
    const values = (snapshot.review?.observations || []).map(item => Number(item.observed_return_pct)).filter(value => Number.isFinite(value))
    if (!values.length) return ''
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    const positive = values.filter(value => value > 0).length
    return `真实表现均值 ${average >= 0 ? '+' : ''}${average.toFixed(2)}% · 上涨 ${positive}/${values.length}`
  }
  const reviewStats = useMemo(() => {
    const observations = snapshots.flatMap(snapshot => snapshot.status === '已复盘' ? (snapshot.review?.observations || []) : [])
    const values = observations.map(item => Number(item.observed_return_pct)).filter(value => Number.isFinite(value))
    const positive = values.filter(value => value > 0).length
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
    return { snapshots: snapshots.filter(snapshot => snapshot.status === '已复盘').length, count: values.length, positive, ratio: values.length ? positive / values.length * 100 : null, average }
  }, [snapshots])
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
      // The review response is intentionally compact. Reload the authoritative
      // snapshot list so observed returns and the aggregate success-rate panel
      // cannot remain stale after a successful review.
      const refreshed = await fetch(`${API}/recommendation-snapshots?limit=20`, { credentials: 'include' })
      const list = await refreshed.json() as { items?: Snapshot[]; detail?: string }
      if (!refreshed.ok) throw new Error(list.detail || `复盘结果读取失败 ${refreshed.status}`)
      setSnapshots(list.items || [])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '推荐复盘失败') }
  }
  const askAI = async (item: Candidate) => {
    setAiLoading(true); setAiSymbol(item.symbol); setAiReply('')
    try {
      const [indexesResult, sentimentResult, flowResult, externalResult] = await Promise.allSettled([
        fetch(`${API}/indexes`, { credentials: 'include' }).then(response => response.ok ? response.json() : null),
        fetch(`${API}/sentiment`, { credentials: 'include' }).then(response => response.ok ? response.json() : null),
        fetch(`${API}/fund-flow`, { credentials: 'include' }).then(response => response.ok ? response.json() : null),
        fetch('/quant/api/external-market/context', { credentials: 'include' }).then(response => response.ok ? response.json() : null),
      ])
      const context = {
        candidate: item,
        recommendation_period: period,
        scan_generated_at: result?.generated_at || null,
        scan_source: result?.data_source || null,
        market_indexes: indexesResult.status === 'fulfilled' ? indexesResult.value : null,
        market_sentiment: sentimentResult.status === 'fulfilled' ? sentimentResult.value : null,
        fund_flow: flowResult.status === 'fulfilled' ? flowResult.value : null,
        external_market: externalResult.status === 'fulfilled' ? externalResult.value : null,
        context_notice: '仅使用接口实际返回的数据；缺失项必须标记为不可用。',
      }
      const response = await fetch(`${API}/ai`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: item.symbol, name: item.name, question: `请复核这只候选是否值得继续观察：综合大盘指数、市场情绪、板块、资金流和美股/外围背景（仅使用实际返回的数据），重点说明当前缺失的数据、触发条件和失效条件，不要给出确定买卖指令。`, context }) })
      const body = await response.json() as { reply?: string; detail?: string }
      if (!response.ok) throw new Error(body.detail || `AI复核失败 ${response.status}`)
      setAiReply(body.reply || 'AI没有返回可用文字。')
    } catch (cause) { setAiReply(cause instanceof Error ? cause.message : 'AI复核失败') } finally { setAiLoading(false) }
  }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-3">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><Target className="h-4 w-4 text-accent" />今日推荐 · 规则候选</div><p className="mt-1 text-[11px] text-muted">最多展示 5 只。它是可追溯的研究候选，不是几分钟后或全天必然走势，也不会自动下单。</p></div>
      <div className="flex items-center gap-2"><Link to="/pick-model" className="rounded-btn border border-border px-3 py-2 text-xs text-accent hover:bg-elevated">拾贝对照</Link><button type="button" onClick={scan} disabled={loading} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? '扫描中…' : '生成今日候选'}</button></div>
    </div>
    <div className={`mb-3 flex flex-wrap items-center gap-2 rounded-card border p-2 text-[11px] ${tickflowStatus?.connected ? 'border-success/30 bg-success/5 text-success' : 'border-warning/40 bg-warning/5 text-warning'}`}><span><b>行情能力：</b>{tickflowStatus?.connected ? `TickFlow 已连接${tickflowStatus.source ? ` · ${tickflowStatus.source}` : ''}` : (tickflowStatus?.message || 'TickFlow 未连接，实时/分钟数据不可用；页面不会用模拟数据补足。')}</span>{!tickflowStatus?.connected && <Link to="/settings?tab=data-sources" className="rounded border border-warning/50 px-2 py-1 text-warning underline-offset-2 hover:underline">前往配置 TickFlow</Link>}</div>
    <div className={`mb-3 flex flex-wrap items-center gap-2 rounded-card border p-2 text-[11px] ${aiStatus?.api_key_configured ? 'border-accent/30 bg-accent/5 text-accent' : 'border-border bg-surface text-muted'}`}><span><b>AI复核：</b>{aiStatus?.api_key_configured ? `已配置${aiStatus.model ? ` · ${aiStatus.model}` : ''}` : '未配置，规则引擎仍可运行；AI复核按钮会保持不可用提示。'}</span>{!aiStatus?.api_key_configured && <Link to="/settings?tab=ai" className="rounded border border-accent/50 px-2 py-1 text-accent underline-offset-2 hover:underline">前往配置 AI</Link>}</div>
    {legacySummary?.available && <div className="mb-3 rounded-card border border-warning/40 bg-warning/5 p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-warning">{legacySummary.label || '历史归档（只读）'}</span><span className="text-muted">已评估，未启用旧自动模拟逻辑</span></div>
      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        <div className="rounded border border-border bg-surface p-2"><div className="text-muted">历史推荐</div><b>{legacySummary.recommendations?.records ?? 0}</b> 条</div>
        <div className="rounded border border-border bg-surface p-2"><div className="text-muted">模拟触发记录</div><b>{legacySummary.recommendations?.paper_status?.submitted ?? 0}</b> 次</div>
        <div className="rounded border border-border bg-surface p-2"><div className="text-muted">研究池</div><b>{legacySummary.research_pool?.items ?? 0}</b> 条</div>
        <div className="rounded border border-border bg-surface p-2"><div className="text-muted">AI报告</div><b>{legacySummary.ai_reports?.count ?? 0}</b> 份</div>
      </div>
      <div className="mt-2 grid gap-3 lg:grid-cols-[1fr_1fr]">
        <div><div className="font-semibold">历史复盘概览</div><div className="mt-1 space-y-1 text-muted">{(legacySummary.reviews?.summary || []).slice(0, 4).map(item => <div key={item.date}> {item.date}：跟踪 {item.tracked ?? '—'} · 表面胜率 {item.win_rate ?? '—'}% · 平均 {item.average_pct == null ? '—' : `${item.average_pct >= 0 ? '+' : ''}${item.average_pct}%`}</div>)}</div></div>
        <div><div className="font-semibold">最近历史触发</div><div className="mt-1 space-y-1 text-muted">{(legacySummary.recommendations?.latest || []).slice(0, 4).map((item, index) => <div key={`${item.created_at || item.date}-${index}`}>{item.created_at || item.date || '—'} · {item.stage || '—'} · {item.paper_status || '未模拟'}{item.paper_symbol ? ` · ${item.paper_symbol}` : ''}</div>)}</div></div>
      </div>
      {!!legacySummary.warnings?.length && <div className="mt-2 space-y-1 border-t border-warning/20 pt-2 text-warning">{legacySummary.warnings.map(warning => <div key={warning}>⚠ {warning}</div>)}</div>}
    </div>}
    <div className="mb-3 grid gap-3 rounded-card border border-border bg-surface p-3 md:grid-cols-[1fr_auto]">
      <div><div className="text-xs font-semibold">本次推荐周期</div><div className="mt-2 flex flex-wrap gap-2">{periodOptions.map(option => <button key={option.value} type="button" onClick={() => setPeriod(option.value)} className={`rounded border px-2.5 py-1.5 text-[11px] ${period === option.value ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted'}`}>{option.label}</button>)}</div><p className="mt-2 text-[11px] text-muted">{selectedPeriod.hint}；扫描算法本身不会把候选伪装成价格预测。</p></div>
      <div className="flex items-end"><button type="button" onClick={saveSnapshot} disabled={!result || !items.length} className="rounded-btn border border-accent/60 px-3 py-2 text-xs text-accent disabled:opacity-40">保存推荐快照</button></div>
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 md:grid-cols-5">{([['baseline_days','长期地量天数'],['max_avg_turnover','换手上限%'],['recent_days','异动窗口天数'],['volume_multiple','放量倍数'],['max_market_cap_yi','市值上限亿']] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-[11px] text-muted">{label}<input type="number" value={criteria[key]} onChange={e => setCriteria({ ...criteria, [key]: Number(e.target.value) })} className="h-8 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label>)}</div>
    {error && <div className="mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {result && <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted"><span>生成于 {result.generated_at || '未标注'}</span><span>数据源：{result.data_source || '未标注'}</span><span>全市场样本 {result.universe_count ?? '—'} · 原始候选 {result.count ?? 0} · 展示 {items.length}/5</span>{result.history_id != null && <span>记录 #{result.history_id}</span>}{quoteUpdatedAt && <span>行情更新 {quoteUpdatedAt} · {quoteNotice}</span>}<span>关联：{linkNotice}</span></div>}
    {result && <div className="mb-3 rounded-card border border-border bg-surface p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2"><b>候选重合对照</b><span className="text-muted">只统计当前真实返回的候选，不代表独立命中率</span></div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <span className="rounded border border-warning/30 bg-warning/5 px-2 py-1">当前持仓 <b>{linkStats.holdings}/{items.length}</b></span>
        <span className="rounded border border-success/30 bg-success/5 px-2 py-1">上传研究池 <b>{linkStats.pools}/{items.length}</b></span>
        <span className="rounded border border-accent/30 bg-accent/5 px-2 py-1">自选 <b>{linkStats.watchlist}/{items.length}</b></span>
        <span className="rounded border border-border px-2 py-1">同板块持仓 <b>{linkStats.sectors}/{items.length}</b></span>
        <span className="rounded border border-border px-2 py-1">提醒批次 <b>{linkStats.lots}/{items.length}</b></span>
      </div>
      <p className="mt-2 text-muted">拾贝模型对照：当前推荐页与“拾贝模型”页面调用同一个扫描接口，因此两者重合属于同源结果，不能当作独立验证。独立成功率只看保存后的真实行情复盘。</p>
    </div>}
    {(aiLoading || aiReply) && <div className="mb-3 rounded-card border border-accent/40 bg-accent/5 p-3"><div className="flex items-center justify-between gap-2 text-xs font-semibold">AI复核 · {aiSymbol}<span className="text-[10px] font-normal text-muted">研究辅助，不自动下单</span></div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-muted">{aiLoading ? '正在结合候选条件和当前可用数据分析…' : aiReply}</p></div>}
    <div className="mb-3 rounded-card border border-border bg-surface p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">推荐复盘</span><span className="text-muted">当前快照：{latestSnapshot ? `${latestSnapshot.period} · ${latestSnapshot.status}` : '尚未保存'}</span></div>
      <p className="mt-1 text-muted">保存后只记录当时的候选、生成时间和数据源；收盘或下一交易日再用真实行情核对。下方“观察正收益率”只统计已经用真实行情复盘的样本，不等同于稳定策略命中率。</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><span className="rounded border border-border/60 bg-elevated/40 px-2 py-1">已复盘快照 <b>{reviewStats.snapshots}</b></span><span className="rounded border border-border/60 bg-elevated/40 px-2 py-1">真实样本 <b>{reviewStats.count}</b></span><span className="rounded border border-border/60 bg-elevated/40 px-2 py-1">正收益 <b>{reviewStats.count ? `${reviewStats.positive}/${reviewStats.count}` : '—'}</b></span><span className="rounded border border-border/60 bg-elevated/40 px-2 py-1">观察正收益率 <b>{reviewStats.ratio == null ? '—' : `${reviewStats.ratio.toFixed(1)}%`}</b>{reviewStats.average != null && <small className="ml-1 text-muted">均值 {reviewStats.average >= 0 ? '+' : ''}{reviewStats.average.toFixed(2)}%</small>}</span></div>
      {!!snapshots.length && <div className="mt-2 grid gap-1 text-muted">{snapshots.slice(0, 3).map(snapshot => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-1"><span>{snapshot.generated_at || snapshot.generatedAt || '—'} · {snapshot.period} · {snapshot.symbols.join('、')}{reviewSummary(snapshot) && <span className="ml-2 text-foreground">{reviewSummary(snapshot)}</span>}</span><span className="flex items-center gap-2">{snapshot.status} · 有效至 {snapshot.valid_until || snapshot.validUntil || '—'}{snapshot.status === '待复盘' && <button type="button" onClick={() => reviewSnapshot(snapshot)} className="rounded border border-accent/60 px-1.5 py-0.5 text-accent">用当前真实行情复盘</button>}</span></div>)}</div>}
    </div>
    {!result && !loading && <div className="rounded-card border border-dashed border-border bg-surface p-10 text-center text-xs text-muted">点击“生成今日候选”后才读取真实扫描结果。</div>}
    {result && !items.length && <div className="rounded-card border border-warning/30 bg-warning/5 p-6 text-center text-xs text-warning">当前没有满足条件的候选。请检查数据时间、TickFlow/公开行情权限和筛选条件；不会用虚构标的补足。</div>}
    {!!items.length && <div className="grid gap-2">{items.map((item, index) => { const action = actionFor(item); const links = linkFor(item); return <article key={item.symbol} className="rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><span className="mr-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">#{index + 1}</span><b>{item.name}</b><span className="ml-2 font-mono text-[11px] text-muted">{item.symbol}</span><div className="mt-1 text-[11px] text-muted">板块 {item.sector || '未识别'} · 生成日 {item.latest_date || '—'}</div></div><div className="text-right"><b className="font-mono">{item.price == null ? '—' : Number(item.price).toFixed(2)}</b><div className={Number(item.pct) >= 0 ? 'text-bull' : 'text-bear'}>{item.pct == null ? '—' : `${Number(item.pct) >= 0 ? '+' : ''}${Number(item.pct).toFixed(2)}%`}</div></div></div><div className="mt-2 flex flex-wrap gap-1.5 text-[10px]"><span className={`rounded border px-1.5 py-0.5 ${links.holdingMatches.length ? 'border-warning/50 bg-warning/10 text-warning' : 'border-border text-muted'}`}>{links.holdingMatches.length ? `同标的持仓 ${links.holdingMatches[0].quantity ?? 0} 股` : '非当前持仓'}</span><span className={`rounded border px-1.5 py-0.5 ${links.lotMatches.length ? 'border-orange-400/50 bg-orange-400/10 text-orange-300' : 'border-border text-muted'}`}>{links.lotMatches.length ? `提醒批次 ${links.lotMatches.length} 个` : '无提醒批次'}</span><span className={`rounded border px-1.5 py-0.5 ${links.watchMatches.length ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted'}`}>{links.watchMatches.length ? '已在自选' : '未在自选'}</span><span className={`rounded border px-1.5 py-0.5 ${links.sectorMatches.length ? 'border-blue-400/50 bg-blue-400/10 text-blue-300' : 'border-border text-muted'}`}>{links.sectorMatches.length ? `同板块持仓 ${links.sectorMatches.length} 只` : '无同板块持仓'}</span><span className={`rounded border px-1.5 py-0.5 ${links.poolMatches.length ? 'border-success/50 bg-success/10 text-success' : 'border-border text-muted'}`}>{links.poolMatches.length ? `研究池命中 ${links.poolMatches.length} 个` : researchPools.length ? '未命中研究池' : '研究池未配置'}</span></div><div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span>评分 <b className="text-accent">{item.score ?? '—'}</b></span><span>优先级 <b>{item.priority || '—'}</b></span><span>阶段 <b>{item.entry_status || '—'}</b></span><span>放量 <b>{item.volume_multiple == null ? '—' : `${item.volume_multiple}x`}</b></span></div><div className="mt-2 rounded border border-accent/20 bg-accent/5 p-2 text-[11px]"><div className="font-semibold">推荐依据（算法实际返回）</div>{item.reasons?.length ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <div className="mt-1 text-muted">旧扫描记录未保存明细依据</div>}{!!item.opposing_evidence?.length && <><div className="mt-2 font-semibold text-warning">反向证据</div><ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">{item.opposing_evidence.map(reason => <li key={reason}>{reason}</li>)}</ul></>}<div className="mt-2 border-t border-border/50 pt-2">条件式操作：<b className="text-accent">{action.label}</b><div className="mt-1 text-muted">触发依据：{action.detail}</div><div className="mt-1 text-muted">信号失效：{action.invalid}</div></div></div><p className="mt-2 text-[11px] text-muted">技术候选需进一步核对板块、资金、情绪和个股数据；缺少确认项时只观察，不生成下单动作。</p><button type="button" onClick={() => askAI(item)} className="mt-2 rounded border border-accent/60 px-2 py-1 text-[11px] text-accent">AI复核这只候选</button></article>})}</div>}
  </div>
}

