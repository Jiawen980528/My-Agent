import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MiniIntraday } from '@/components/stock-table/MiniIntraday'
import type { MinuteKlineRow } from '@/lib/api'

const API = '/quant/api/myagent/quant'
const MYAGENT_ROOT = '/quant/api/myagent'

type Holding = { symbol: string; name: string; sector: string; quantity: number; cost: number; price?: number; pct?: number; profit?: number; profit_pct?: number }
type Sector = { sector: string; theme: string }
type SectorStock = { symbol: string; name: string; price: number; pct: number; volume_ratio: number; turnover: number }
type SectorSnapshot = { sector: string; generated_at: string; source: string; items: SectorStock[] }
type NewsItem = { title: string; url: string; source: string; published_at?: string; relevance: string; watch_reason: string;
  bias: '可能利好' | '可能利空' | '待判断'; bias_reason: string; sector_names: string[] }
type NewsFeed = { items: NewsItem[]; fetched_at: string; source: string; status: string; notice: string }
type MinuteBatch = { data: Record<string, MinuteKlineRow[]>; source?: string; freshness?: Record<string, { market_time?: string | null; stale?: boolean }> }
type RecommendationSnapshot = { id: number; period: string; status: '待复盘' | '已复盘'; generated_at: string; valid_until: string; symbols: string[]; data_source?: string; review?: { observations?: Array<{ observed_return_pct?: number | null }> } | null }
type PaperSummaryRow = { account: string; name: string; status: 'active' | 'frozen'; total: number; cash: number; market_value: number; total_pnl: number; pnl_pct?: number | null; rounds: number; win_rate: number; profit_loss_ratio?: number | null; max_drawdown?: number | null; nav?: Array<{ date: string; nav: number }>; live_total?: number | null; live_pnl_pct?: number | null; estimating?: boolean }
type AIConfig = { api_key_configured?: boolean; model?: string }
type LegacySummary = { available?: boolean; label?: string; recommendations?: { records?: number; paper_status?: Record<string, number> }; reviews?: { days?: number }; research_pool?: { items?: number }; ai_reports?: { count?: number }; warnings?: string[] }

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `请求失败 ${response.status}`)
  return body as T
}

function signed(value: number | undefined, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}`
}

function latestMarketDay() {
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1)
  return day.toLocaleDateString('en-CA')
}

function qualified(symbol: string) {
  const value = symbol.trim().toUpperCase().replace(/\.SS$/, '.SH')
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value
  if (!/^\d{6}$/.test(value)) return value
  return `${value}${value.startsWith('5') || value.startsWith('6') || value.startsWith('688') ? '.SH' : '.SZ'}`
}

function minuteRows(batch: MinuteBatch | undefined, symbol: string) {
  const key = qualified(symbol)
  const raw = batch?.data?.[key] || batch?.data?.[symbol] || []
  return raw.filter(row => Number.isFinite(Number(row.close)) && row.datetime).slice(-240)
}

function PaperMiniCurve({ nav }: { nav: Array<{ date: string; nav: number }> }) {
  const values = nav.map(row => Number(row.nav)).filter(Number.isFinite)
  if (values.length < 2) return <div className="flex h-12 items-center justify-center text-[10px] text-muted">暂无权益曲线</div>
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${42 - ((value - min) / span) * 34}`).join(' ')
  return <svg viewBox="0 0 100 48" preserveAspectRatio="none" className="h-12 w-full rounded border border-border bg-base/50" role="img" aria-label="模拟盘权益曲线">
    <polyline points={points} fill="none" stroke="#8B5CF6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
  </svg>
}

export function MarketNewsWidget() {
  const [sort, setSort] = useState<'relevance' | 'latest'>('relevance')
  const [bias, setBias] = useState<'全部' | NewsItem['bias']>('全部')
  const [sector, setSector] = useState('全部板块')
  const [holdingsOnly, setHoldingsOnly] = useState(false)
  const [analysis, setAnalysis] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const news = useQuery({ queryKey: ['myagent-quant-news'], queryFn: () => getJson<NewsFeed>(`${API}/news`), refetchInterval: 180_000 })
  const allRows = news.data?.items ?? []
  const sectorNames = [...new Set(allRows.flatMap(item => item.sector_names ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const rows = allRows.filter(item => (bias === '全部' || item.bias === bias)
    && (sector === '全部板块' || item.sector_names?.includes(sector))
    && (!holdingsOnly || item.relevance === '持仓相关'))
  if (sort === 'latest') rows.sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')))
  const analyze = async (item: NewsItem) => {
    setAnalyzing(true); setAnalysis('')
    try {
      const result = await fetch('/quant/api/myagent/chat', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message:
          `请结合我的已记录持仓、当前行情和原文，分析这条新闻可能影响的股票、板块、方向和待验证条件。标题关键词初判为「${item.bias}」、板块为「${item.sector_names.join('、') || '未识别'}」，请独立核对，不要照搬初判。若无法读取原文或实时行情请明确说明，不要猜测。新闻标题：${item.title}；链接：${item.url}` }) })
      const data = await result.json() as { reply?: string; detail?: string }
      if (!result.ok) throw new Error(data.detail ?? `AI 请求失败 ${result.status}`)
      setAnalysis(data.reply ?? '未返回分析')
    } catch (error) { setAnalysis(`AI 分析暂不可用：${(error as Error).message}`) } finally { setAnalyzing(false) }
  }
  return <section className="h-full overflow-auto rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-xs font-semibold">市场新闻 · 持仓关联</h2><p className="text-[10px] text-muted">{news.data?.source ?? '公开新闻源'} · 约 3 分钟更新</p></div>
      <div className="flex items-center gap-2"><Link to="/market-news" className="text-[11px] text-accent hover:underline">打开完整页</Link><select aria-label="新闻排序" value={sort} onChange={e => setSort(e.target.value as typeof sort)} className="rounded-btn border border-border bg-base px-2 py-1 text-xs"><option value="relevance">相关优先</option><option value="latest">最新优先</option></select></div></div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-y border-border py-2 text-[11px]">
      {(['全部', '可能利好', '可能利空', '待判断'] as const).map(value => <button key={value} type="button" onClick={() => setBias(value)}
        aria-pressed={bias === value} className={`rounded-btn px-2 py-1 ${bias === value ? 'bg-accent/20 text-accent' : 'bg-elevated text-secondary'}`}>
        {value} {value === '全部' ? allRows.length : allRows.filter(item => item.bias === value).length}
      </button>)}
      <select aria-label="新闻板块筛选" value={sector} onChange={e => setSector(e.target.value)} className="rounded-btn border border-border bg-base px-2 py-1 text-secondary"><option>全部板块</option>{sectorNames.map(name => <option key={name}>{name}</option>)}</select>
      <label className="ml-auto flex items-center gap-1 text-muted"><input type="checkbox" checked={holdingsOnly} onChange={e => setHoldingsOnly(e.target.checked)} />只看持仓</label>
    </div>
    {news.isLoading && <p className="mt-3 text-xs text-muted">正在获取新闻…</p>}
    {news.isError && <p className="mt-3 text-xs text-danger">新闻暂不可用：{(news.error as Error).message}</p>}
    {news.data && <><p className="mt-2 text-[10px] text-muted">获取于 {new Date(news.data.fetched_at).toLocaleString('zh-CN')} · {news.data.notice}</p>
      {!rows.length && <p className="mt-3 text-xs text-muted">{allRows.length ? '当前筛选条件下没有新闻，请切换方向或板块。' : '当前没有可用新闻。请稍后刷新。'}</p>}
      {analysis && <div className="mt-2 whitespace-pre-wrap rounded border border-accent/30 bg-accent/5 p-2 text-xs">{analysis}</div>}
      {rows.map((item, i) => <div key={`${item.url}-${i}`} className="border-b border-border py-2">
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted"><span className={item.bias === '可能利好' ? 'text-bull' : item.bias === '可能利空' ? 'text-bear' : 'text-muted'}>{item.bias}</span><span>· {item.relevance}</span><span>· {item.source}</span><span className="ml-auto">{item.published_at ? new Date(item.published_at).toLocaleString('zh-CN') : '时间未知'}</span></div>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs hover:text-accent">{item.title}</a><div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted"><span>{item.watch_reason}</span><button type="button" onClick={() => analyze(item)} disabled={analyzing} className="ml-auto shrink-0 text-accent disabled:opacity-50">AI研判影响</button></div>
        <div className="mt-1 text-[11px] text-secondary">板块：{item.sector_names?.join('、') || '未识别具体板块'} <span className="text-muted">· {item.bias_reason}</span></div>
      </div>)}</>}
  </section>
}

export function HoldingsWidget() {
  const holdings = useQuery({ queryKey: ['myagent-quant-holdings'], queryFn: () => getJson<{ items: Holding[]; notice: string }>(`${API}/holdings`), refetchInterval: 30_000 })
  const sectors = useQuery({ queryKey: ['myagent-quant-sectors'], queryFn: () => getJson<{ items: Sector[] }>(`${API}/sectors`), staleTime: 10 * 60_000 })
  const [editing, setEditing] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [cost, setCost] = useState('')
  const [sector, setSector] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<'manual' | 'pctAsc' | 'pctDesc' | 'profitAsc' | 'profitDesc'>('manual')

  const openForm = (item?: Holding) => {
    setSymbol(item?.symbol || ''); setName(item?.name || '')
    setQuantity(item ? String(item.quantity) : ''); setCost(item ? String(item.cost) : '')
    setSector(item?.sector || ''); setError(''); setEditing(true)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!/^\d{6}$/.test(symbol) || !name.trim() || Number(quantity) <= 0 || Number(cost) < 0) {
      setError('请填写六位股票代码、名称、持仓数量和有效成本价')
      return
    }
    setSaving(true); setError('')
    try {
      const response = await fetch(`${API}/holdings/${symbol}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, name: name.trim(), quantity: Number(quantity), cost: Number(cost), sector, source: 'manual' }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || `保存失败 ${response.status}`)
      setEditing(false)
      await holdings.refetch()
    } catch (err) { setError((err as Error).message) } finally { setSaving(false) }
  }

  const rows = [...(holdings.data?.items || [])]
  if (sort === 'pctAsc') rows.sort((a, b) => Number(a.pct ?? 0) - Number(b.pct ?? 0))
  if (sort === 'pctDesc') rows.sort((a, b) => Number(b.pct ?? 0) - Number(a.pct ?? 0))
  if (sort === 'profitAsc') rows.sort((a, b) => Number(a.profit ?? 0) - Number(b.profit ?? 0))
  if (sort === 'profitDesc') rows.sort((a, b) => Number(b.profit ?? 0) - Number(a.profit ?? 0))
  const minute = useQuery({
    queryKey: ['myagent-quant-holding-minutes', rows.map(row => qualified(row.symbol)).sort().join(','), latestMarketDay()],
    queryFn: () => getJson<MinuteBatch>(`${API}/portfolio/minute-batch?trade_date=${latestMarketDay()}`),
    enabled: rows.length > 0,
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
  return <section className="h-full overflow-auto rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex items-center justify-between gap-2">
      <div><h2 className="text-xs font-semibold">持仓涨跌</h2><p className="mt-0.5 text-[10px] text-muted">MyAgent 手工记录 · 公开行情约 30 秒刷新</p></div>
      <div className="flex gap-1"><select aria-label="持仓排序" value={sort} onChange={e => setSort(e.target.value as typeof sort)} className="rounded-btn border border-border bg-base px-1 py-1 text-[10px]"><option value="manual">原顺序</option><option value="pctAsc">涨幅升序</option><option value="pctDesc">涨幅降序</option><option value="profitAsc">盈亏升序</option><option value="profitDesc">盈亏降序</option></select>
      <button type="button" onClick={() => editing ? setEditing(false) : openForm()} className="shrink-0 rounded-btn border border-border px-2 py-1 text-[11px] text-accent">{editing ? '取消' : '录入持仓'}</button></div>
    </div>
    {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    {editing && <form onSubmit={save} className="mt-2 grid grid-cols-2 gap-1.5 border-y border-border py-2 text-xs">
      <input aria-label="股票代码" inputMode="numeric" maxLength={6} placeholder="六位代码" value={symbol} onChange={e => setSymbol(e.target.value)} className="min-w-0 rounded-btn border border-border bg-base px-2 py-1.5" />
      <input aria-label="股票名称" maxLength={40} placeholder="股票名称" value={name} onChange={e => setName(e.target.value)} className="min-w-0 rounded-btn border border-border bg-base px-2 py-1.5" />
      <input aria-label="持仓数量" type="number" min="1" placeholder="持仓数量" value={quantity} onChange={e => setQuantity(e.target.value)} className="min-w-0 rounded-btn border border-border bg-base px-2 py-1.5" />
      <input aria-label="持仓成本价" type="number" min="0" step="0.001" placeholder="成本价" value={cost} onChange={e => setCost(e.target.value)} className="min-w-0 rounded-btn border border-border bg-base px-2 py-1.5" />
      <select aria-label="关联板块" value={sector} onChange={e => setSector(e.target.value)} className="min-w-0 rounded-btn border border-border bg-base px-2 py-1.5"><option value="">自动匹配板块</option>{(sectors.data?.items || []).map(x => <option key={x.sector} value={x.sector}>{x.sector}</option>)}</select>
      <button disabled={saving} className="rounded-btn bg-accent px-2 py-1.5 text-white disabled:opacity-50">{saving ? '保存中…' : '保存持仓'}</button>
    </form>}
    {holdings.isLoading && <p className="mt-3 text-xs text-muted">加载持仓…</p>}
    {holdings.error && <p className="mt-3 text-xs text-danger">{(holdings.error as Error).message}</p>}
    {!rows.length && !holdings.isLoading && !holdings.error && <p className="mt-4 text-xs text-muted">暂无持仓记录。点击“录入持仓”后会显示价格、涨跌和浮盈亏。</p>}
    {rows.map(x => <button key={x.symbol} type="button" onClick={() => openForm(x)} className="mt-2 grid w-full grid-cols-[minmax(0,1fr)_112px_auto_auto] items-center gap-2 border-t border-border pt-2 text-left text-xs hover:text-accent">
      <span className="min-w-0"><b className="block truncate">{x.name} <span className="font-normal text-muted">{x.symbol}</span></b><span className="text-[10px] text-muted">{x.sector || '待绑定'} · {x.quantity} 股 · 成本 {Number(x.cost).toFixed(2)}</span></span>
      <span className="w-28 overflow-hidden"><MiniIntraday rows={minuteRows(minute.data, x.symbol)} prevClose={x.price != null && x.pct != null ? Number(x.price) / (1 + Number(x.pct) / 100) : null} changePct={x.pct != null ? Number(x.pct) / 100 : null} width={112} height={44} volume /><small className="block truncate text-[9px] text-muted">{minute.data?.source || (minute.isLoading ? '分时读取中…' : '暂无真实分时')}</small></span>
      <span className="text-right"><b className="block">{x.price ? Number(x.price).toFixed(2) : '—'}</b><span className={Number(x.pct) >= 0 ? 'text-danger' : 'text-success'}>{signed(x.pct)}%</span></span>
      <span className={`w-20 text-right ${Number(x.profit) >= 0 ? 'text-danger' : 'text-success'}`}>{x.price ? signed(x.profit) : '—'}<small className="block text-[10px]">{x.price ? `${signed(x.profit_pct)}%` : '暂无报价'}</small></span>
    </button>)}
    <p className="mt-2 text-[10px] text-muted">持仓需手工录入；当前未连接券商账户。<Link to="/portfolio-terminal" className="text-accent">打开持仓终端</Link></p>
  </section>
}

export function RecommendationWidget() {
  const holdings = useQuery({
    queryKey: ['myagent-quant-holdings-for-recommendations'],
    queryFn: () => getJson<{ items: Holding[] }>(`${API}/holdings`),
    refetchInterval: 30_000,
  })
  const snapshots = useQuery({
    queryKey: ['myagent-recommendation-snapshots'],
    queryFn: () => getJson<{ items: RecommendationSnapshot[] }>(`${API}/recommendation-snapshots?limit=5`),
    refetchInterval: 30_000,
  })
  const ai = useQuery({
    queryKey: ['myagent-ai-config'],
    queryFn: () => getJson<AIConfig>(`${MYAGENT_ROOT}/config`),
    staleTime: 60_000,
  })
  const legacy = useQuery({
    queryKey: ['myagent-legacy-summary'],
    queryFn: () => getJson<LegacySummary>(`${API}/legacy-summary`),
    refetchInterval: 180_000,
  })
  const holdingCodes = new Set((holdings.data?.items || []).map(item => String(item.symbol).replace(/\D/g, '')))
  const items = (snapshots.data?.items || []).filter(snapshot =>
    holdingCodes.size > 0 && snapshot.symbols.some(symbol => holdingCodes.has(String(symbol).replace(/\D/g, ''))),
  )
  const pending = items.filter(item => item.status === '待复盘')
  const reviewedValues = items.flatMap(item => item.status === '已复盘' ? (item.review?.observations || []) : [])
    .map(item => Number(item.observed_return_pct)).filter(Number.isFinite)
  const reviewedPositive = reviewedValues.filter(value => value > 0).length
  const reviewedRate = reviewedValues.length ? reviewedPositive / reviewedValues.length * 100 : null
  const reviewedAverage = reviewedValues.length ? reviewedValues.reduce((sum, value) => sum + value, 0) / reviewedValues.length : null
  return <section className="h-full overflow-auto rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex items-center justify-between gap-2"><div><h2 className="text-xs font-semibold">我的持仓提醒 / 预测复盘</h2><p className="mt-0.5 text-[10px] text-muted">只显示涉及当前手工持仓的快照 · 约 30 秒刷新</p></div><Link to="/recommendations" className="text-[11px] text-accent hover:underline">打开全市场推荐</Link></div>
    <div className="mt-2 flex flex-wrap gap-2 text-[10px]"><span className="rounded bg-accent/10 px-2 py-1 text-accent">待复盘 {pending.length}</span><span className="rounded bg-elevated px-2 py-1 text-muted">已记录 {items.length}</span><span className={`rounded px-2 py-1 ${ai.data?.api_key_configured ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'}`}>AI {ai.data?.api_key_configured ? '可用' : '未配置'}</span>{reviewedRate != null && <span className="rounded bg-elevated px-2 py-1 text-secondary">真实观察上涨率 {reviewedRate.toFixed(1)}%（{reviewedPositive}/{reviewedValues.length}）{reviewedAverage != null ? ` · 均值 ${reviewedAverage >= 0 ? '+' : ''}${reviewedAverage.toFixed(2)}%` : ''}</span>}</div>
    {snapshots.isLoading && <p className="mt-3 text-xs text-muted">读取推荐记录…</p>}
    {snapshots.error && <p className="mt-3 text-xs text-danger">推荐记录暂不可用：{(snapshots.error as Error).message}</p>}
    {legacy.data?.available && <div className="mt-2 rounded border border-warning/30 bg-warning/5 p-2 text-[10px]"><div className="flex items-center justify-between gap-2"><b className="text-warning">{legacy.data.label || '历史归档（只读）'}</b><span className="text-muted">不启用旧模拟逻辑</span></div><div className="mt-1 text-muted">历史推荐 {legacy.data.recommendations?.records ?? 0} 条 · 模拟触发 {legacy.data.recommendations?.paper_status?.submitted ?? 0} 次 · 复盘 {legacy.data.reviews?.days ?? 0} 天 · 研究池 {legacy.data.research_pool?.items ?? 0} 条</div>{legacy.data.warnings?.some(item => item.includes('异常口径')) && <div className="mt-1 text-warning">⚠ 历史复盘成功率口径异常，当前仅作参考</div>}</div>}
    {!snapshots.isLoading && !holdings.isLoading && !snapshots.error && !items.length && <p className="mt-3 text-xs text-muted">当前没有涉及持仓的推荐快照；全市场候选请前往“个股搜索/推荐”，不会把非持仓候选混入看板。</p>}
    <div className="mt-2 grid gap-1.5">{items.slice(0, 3).map(item => <div key={item.id} className="rounded border border-border/70 bg-base/40 p-2 text-[10px]"><div className="flex justify-between gap-2"><b>{item.period}</b><span className={item.status === '待复盘' ? 'text-warning' : 'text-bull'}>{item.status}</span></div><div className="mt-1 text-muted">{item.generated_at} · {item.symbols.join('、')}</div><div className="mt-1 text-muted">有效至 {item.valid_until}</div></div>)}</div>
  </section>
}

export function PaperSummaryWidget() {
  const paper = useQuery({
    queryKey: ['myagent-paper-dashboard-summary'],
    queryFn: () => getJson<{ accounts: PaperSummaryRow[] }>('/quant/api/paper/compare'),
    refetchInterval: 30_000,
  })
  const account = paper.data?.accounts?.find(row => row.account === 'myagent_auto') || paper.data?.accounts?.[0]
  const total = account?.live_total ?? account?.total
  const pnlPct = account?.live_pnl_pct ?? account?.pnl_pct
  return <section className="h-full overflow-auto rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex items-center justify-between gap-2"><div><h2 className="text-xs font-semibold">暗黑模拟盘摘要</h2><p className="mt-0.5 text-[10px] text-muted">只读统计 · 不连接券商 · 不自动下单</p></div><Link to="/paper" className="text-[11px] text-accent hover:underline">打开模拟盘</Link></div>
    {paper.isLoading && <p className="mt-3 text-xs text-muted">读取模拟账户…</p>}
    {paper.error && <p className="mt-3 text-xs text-warning">模拟盘摘要暂不可用：{(paper.error as Error).message}</p>}
    {!paper.isLoading && !paper.error && !account && <p className="mt-3 text-xs text-muted">尚未创建模拟账户；打开模拟盘后可建立独立的虚拟账户。</p>}
    {account && <>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]"><span className="rounded bg-accent/10 px-2 py-1 text-accent">{account.name || account.account}</span><span className={account.status === 'active' ? 'rounded bg-bull/10 px-2 py-1 text-bull' : 'rounded bg-warning/10 px-2 py-1 text-warning'}>{account.status === 'active' ? '运行中' : '已冻结'}</span>{account.estimating && <span className="rounded bg-warning/10 px-2 py-1 text-warning">盘中估算</span>}</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4"><span className="rounded bg-elevated p-2">权益<br /><b>{total == null ? '—' : `¥${Number(total).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`}</b></span><span className="rounded bg-elevated p-2">收益率<br /><b className={Number(pnlPct) >= 0 ? 'text-bull' : 'text-bear'}>{pnlPct == null ? '—' : `${Number(pnlPct) >= 0 ? '+' : ''}${Number(pnlPct).toFixed(2)}%`}</b></span><span className="rounded bg-elevated p-2">胜率<br /><b>{account.rounds ? `${Number(account.win_rate).toFixed(1)}%` : '—'}</b></span><span className="rounded bg-elevated p-2">最大回撤<br /><b>{account.max_drawdown == null ? '—' : `${Number(account.max_drawdown).toFixed(2)}%`}</b></span></div>
      <div className="mt-2"><PaperMiniCurve nav={account.nav || []} /></div>
      <p className="mt-1 text-[10px] text-muted">已完成回合 {account.rounds} · 现金 ¥{Number(account.cash || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} · 统计来自独立模拟账户。</p>
    </>}
  </section>
}

export function SectorWatchWidget() {
  const holdings = useQuery({ queryKey: ['myagent-quant-holdings'], queryFn: () => getJson<{ items: Holding[] }>(`${API}/holdings`), refetchInterval: 30_000 })
  const sectors = useQuery({ queryKey: ['myagent-quant-sectors'], queryFn: () => getJson<{ items: Sector[] }>(`${API}/sectors`), staleTime: 10 * 60_000 })
  const [selected, setSelected] = useState('')
  const [sort, setSort] = useState<'hot' | 'pctAsc' | 'pctDesc' | 'volumeAsc' | 'volumeDesc'>('hot')
  const [movement, setMovement] = useState<Record<string, number>>({})
  const previous = useRef<{ sector: string; values: Record<string, number> }>({ sector: '', values: {} })
  const options = sectors.data?.items || []
  const linked = [...new Set((holdings.data?.items || []).map(x => x.sector).filter(x => options.some(option => option.sector === x)))]
  useEffect(() => {
    if (!selected && linked.length) setSelected(linked[0])
  }, [selected, linked.join('|')])
  const snapshot = useQuery({
    queryKey: ['myagent-sector-watch', selected],
    queryFn: () => getJson<SectorSnapshot>(`${API}/sector/${encodeURIComponent(selected)}`),
    enabled: !!selected, refetchInterval: 30_000,
  })
  useEffect(() => {
    if (!snapshot.data) return
    const values: Record<string, number> = {}
    const changes: Record<string, number> = {}
    for (const item of snapshot.data.items) {
      values[item.symbol] = Number(item.pct) || 0
      const old = previous.current.sector === selected ? previous.current.values[item.symbol] : undefined
      if (old != null) changes[item.symbol] = values[item.symbol] - old
    }
    previous.current = { sector: selected, values }
    setMovement(changes)
  }, [snapshot.data, selected])
  const rows = [...(snapshot.data?.items || [])].sort((a, b) => {
    if (sort === 'pctAsc') return a.pct - b.pct
    if (sort === 'pctDesc') return b.pct - a.pct
    if (sort === 'volumeAsc') return a.volume_ratio - b.volume_ratio
    if (sort === 'volumeDesc') return b.volume_ratio - a.volume_ratio
    const hotA = (movement[a.symbol] || 0) >= 0.8 || (a.volume_ratio >= 2 && a.pct >= 2) ? 1 : 0
    const hotB = (movement[b.symbol] || 0) >= 0.8 || (b.volume_ratio >= 2 && b.pct >= 2) ? 1 : 0
    return hotB - hotA || b.pct - a.pct
  })
  const hot = (x: SectorStock) => (movement[x.symbol] || 0) >= 0.8 || (x.volume_ratio >= 2 && x.pct >= 2)
  return <section className="h-full overflow-auto rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-xs font-semibold">关联板块 · 个股异动</h2><p className="mt-0.5 text-[10px] text-muted">公开行情快照 · 约 30 秒检查一次</p></div>
      <div className="flex gap-1"><select aria-label="板块个股排序" value={sort} onChange={e => setSort(e.target.value as typeof sort)} className="max-w-24 rounded-btn border border-border bg-base px-1 py-1 text-xs"><option value="hot">异动优先</option><option value="pctAsc">涨幅升序</option><option value="pctDesc">涨幅降序</option><option value="volumeAsc">量比升序</option><option value="volumeDesc">量比降序</option></select><select aria-label="选择跟踪板块" value={selected} onChange={e => { setSelected(e.target.value); setMovement({}) }} className="max-w-44 rounded-btn border border-border bg-base px-2 py-1 text-xs"><option value="">选择板块</option>{options.map(x => <option key={x.sector} value={x.sector}>{x.sector}{linked.includes(x.sector) ? ' · 持仓关联' : ''}</option>)}</select></div>
    </div>
    {!!linked.length && <p className="mt-2 text-[10px] text-muted">持仓关联：{linked.join('、')}</p>}
    {!linked.length && <p className="mt-2 text-[10px] text-muted">暂无持仓板块；可先手选板块观察，或在“持仓涨跌”窗口录入持仓。</p>}
    {snapshot.error && <p className="mt-2 text-xs text-danger">{(snapshot.error as Error).message}</p>}
    {selected && snapshot.isLoading && <p className="mt-3 text-xs text-muted">加载板块个股…</p>}
    {snapshot.data && <><div className="mt-2 flex flex-wrap gap-3 border-y border-border py-2 text-[10px] text-muted"><span>{snapshot.data.sector} · {rows.length} 只</span><span>快照 {snapshot.data.generated_at}</span><span>异动 {rows.filter(hot).length} 只</span></div>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_60px_64px_60px] gap-1 border-b border-border py-1 text-[10px] text-muted"><span>个股</span><span className="text-right">涨跌</span><span className="text-right">较上次</span><span className="text-right">量比</span></div>
      {rows.map(x => <div key={x.symbol} className="grid grid-cols-[minmax(0,1fr)_60px_64px_60px] items-center gap-1 border-b border-border/60 py-1.5 text-xs"><span className="min-w-0 truncate">{hot(x) && <span className="mr-1 rounded bg-warning/15 px-1 text-[9px] text-warning">异动</span>}{x.name} <small className="text-[10px] text-muted">{x.symbol}</small></span><span className={`text-right ${x.pct >= 0 ? 'text-danger' : 'text-success'}`}>{signed(x.pct)}%</span><span className="text-right text-muted">{movement[x.symbol] == null ? '观察中' : `${signed(movement[x.symbol])}%`}</span><span className="text-right">{Number(x.volume_ratio || 0).toFixed(2)}</span></div>)}
    </>}
    <p className="mt-2 text-[10px] text-muted">异动：较上次快照涨幅增加 ≥0.8 个百分点，或量比 ≥2 且日涨幅 ≥2%。页面关闭时不持续监控；公开源非逐笔行情。</p>
  </section>
}
