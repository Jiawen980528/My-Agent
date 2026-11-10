import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { BarChart3, Bot, ExternalLink, Globe2, Info, LineChart, RefreshCw } from 'lucide-react'
import { EChartsIntraday } from '@/components/EChartsIntraday'
import { api, type OverviewMarket } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { startReviewGeneration, isReviewGenerating } from '@/lib/reviewStore'
import { useReviewState } from '@/lib/useReviewStore'
import { fmtBigNum } from '@/lib/format'
import { cn } from '@/lib/cn'

const INDEXES = [
  { symbol: '000001.SH', name: '上证指数' },
  { symbol: '399001.SZ', name: '深证成指' },
  { symbol: '399006.SZ', name: '创业板指' },
  { symbol: '000688.SH', name: '科创50' },
]

const SIGNAL_LABELS: Record<string, string> = {
  limit_up: '涨停', broken: '炸板', recovery: '翘板', limit_down: '跌停', new_high: '新高', new_low: '新低', volume_surge: '放量',
}

function amount(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}万`
  return v.toFixed(0)
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function tone(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-muted'
  return v > 0 ? 'text-bull' : 'text-bear'
}

function forecastText(value: number | undefined | null): string {
  return value == null ? '—' : amount(value)
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function sumAmounts(rows: Array<{ amount?: number | null }>): number | null {
  const values = rows.map(row => Number(row.amount)).filter(value => Number.isFinite(value) && value > 0)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}

function volumeProgress(rows: Array<{ datetime?: string }>): number {
  if (rows.length < 2) return rows.length ? 0.1 : 0
  const first = Date.parse(rows[0].datetime ?? '')
  const last = Date.parse(rows.at(-1)?.datetime ?? '')
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return Math.min(1, rows.length / 240)
  return Math.min(1, Math.max(0.05, (last - first) / (4 * 60 * 60 * 1000)))
}

type DashboardNewsItem = { title: string; url: string; source?: string; published_at?: string; bias?: string; sector_names?: string[] }
type DashboardNewsFeed = { items?: DashboardNewsItem[]; fetched_at?: string; source?: string; notice?: string }
type BoardMinuteResponse = { board?: { name?: string | null; code?: string | null } | null; rows?: Array<{ datetime?: string; time?: string; close?: number; high?: number; low?: number; volume?: number; amount?: number | null }>; source?: string }

async function dashboardJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `请求失败 ${response.status}`)
  return body as T
}

export function MarketOverviewWidget({ data, tradeDate }: { data: OverviewMarket; tradeDate?: string }) {
  const [selectedSymbol, setSelectedSymbol] = useState(INDEXES[0].symbol)
  const [selectedDate, setSelectedDate] = useState(() => tradeDate ?? data.as_of?.slice(0, 10) ?? '')
  const [expanded, setExpanded] = useState(false)
  const [focusStock, setFocusStock] = useState<{ symbol: string; name?: string | null } | null>(null)
  const [forecastTab, setForecastTab] = useState<'model' | 'ai' | 'public'>('model')
  const minute = useQuery({
    queryKey: ['dashboard-market-index-minute', selectedSymbol, selectedDate || 'latest'],
    queryFn: () => api.indexMinute(selectedSymbol, selectedDate || undefined),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const indexMinuteQueries = useQueries({ queries: INDEXES.map(item => ({
    queryKey: ['dashboard-market-index-volume-minute', item.symbol, selectedDate || 'latest'],
    queryFn: () => api.indexMinute(item.symbol, selectedDate || undefined),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })) })
  const indexDailyQueries = useQueries({ queries: INDEXES.map(item => ({
    queryKey: ['dashboard-market-index-volume-daily', item.symbol],
    queryFn: () => api.indexDaily(item.symbol, 20),
    staleTime: 5 * 60_000,
  })) })
  const volume = useQuery({
    queryKey: QK.marketVolumeForecast(tradeDate),
    queryFn: () => api.marketVolumeForecast(tradeDate),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const portfolio = useQuery({
    queryKey: ['dashboard-portfolio-snapshot'],
    queryFn: () => api.portfolioSnapshot(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const abnormal = useQuery({
    queryKey: ['dashboard-abnormal-intraday'],
    queryFn: () => api.abnormalIntraday(60),
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
  const news = useQuery({
    queryKey: ['myagent-quant-news'],
    queryFn: () => dashboardJson<DashboardNewsFeed>('/quant/api/myagent/quant/news'),
    refetchInterval: 180_000,
    staleTime: 60_000,
  })
  const focusMinute = useQuery({
    queryKey: ['dashboard-focus-stock-minute', focusStock?.symbol, selectedDate || 'latest'],
    queryFn: () => api.klineMinute(focusStock!.symbol, selectedDate || undefined, true),
    enabled: !!focusStock?.symbol,
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
  const focusBoard = useQuery({
    queryKey: ['dashboard-focus-stock-board', focusStock?.symbol, selectedDate || 'latest'],
    queryFn: () => dashboardJson<BoardMinuteResponse>(`/quant/api/myagent/quant/portfolio/board/${encodeURIComponent(focusStock!.symbol)}?trade_date=${encodeURIComponent(selectedDate || '')}`),
    enabled: !!focusStock?.symbol,
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
  const review = useReviewState()
  const generating = isReviewGenerating()
  const selected = INDEXES.find(item => item.symbol === selectedSymbol) ?? INDEXES[0]
  const publicIndex = data.indices.find(item => item.symbol === selectedSymbol)
  const recentAI = review.content.trim().replace(/[#*_`]/g, '').replace(/\s+/g, ' ').slice(0, 420)
  const chartRows = minute.data?.rows ?? []
  const indexVolumeStats = useMemo(() => INDEXES.map((item, index) => {
    const quote = data.indices.find(row => row.symbol === item.symbol)
    const rows = item.symbol === selectedSymbol ? chartRows : (indexMinuteQueries[index]?.data?.rows ?? [])
    const current = sumAmounts(rows) ?? (quote?.amount ?? null)
    const historical = median((indexDailyQueries[index]?.data?.rows ?? []).map(row => Number(row.amount)).filter(value => Number.isFinite(value) && value > 0))
    const change = current != null && historical ? (current / historical - 1) * 100 : null
    const progress = volumeProgress(rows)
    const forecast = current != null && progress > 0 ? current / progress : null
    return { ...item, current, historical, change, forecast, progress, rows: rows.length }
  }), [chartRows, data.indices, indexDailyQueries, indexMinuteQueries, selectedSymbol])
  const forecastRatio = volume.data?.status === 'ok' && volume.data.forecast_amount
    ? (volume.data.current_cumulative_amount ?? 0) / volume.data.forecast_amount
    : null
  const sourceText = minute.data?.source ?? '分钟数据源未标注'
  const strongSectors = [...(data.concept_rank?.leading ?? []), ...(data.industry_rank?.leading ?? [])]
    .sort((a, b) => (b.avg_pct ?? 0) - (a.avg_pct ?? 0)).slice(0, 6)
  const recommendationRows = [...(data.top_gainers ?? []), ...(data.active_leaders ?? []), ...(data.turnover_leaders ?? [])]
    .filter((row, index, all) => row.symbol && all.findIndex(item => item.symbol === row.symbol) === index)
    .slice(0, 12)
  const abnormalRows = (abnormal.data?.rows ?? []).slice(0, 12)
  const newsRows = (news.data?.items ?? []).slice(0, 4)
  const focusBoardRows = (focusBoard.data?.rows ?? []).map(row => ({
    datetime: row.datetime ?? row.time ?? '',
    open: Number(row.close ?? 0),
    high: Number(row.high ?? row.close ?? 0),
    low: Number(row.low ?? row.close ?? 0),
    close: Number(row.close ?? 0),
    volume: Number(row.volume ?? 0),
    amount: row.amount == null ? null : Number(row.amount),
  })).filter(row => row.datetime && Number.isFinite(row.close))
  const marketStats = useMemo(() => [
    { label: '当前成交额', value: fmtBigNum(data.amount.total), sub: '点击右侧预测' },
    { label: '上涨 / 下跌', value: `${data.breadth.up} / ${data.breadth.down}`, sub: `上涨率 ${data.breadth.up_pct.toFixed(1)}%` },
    { label: '涨停 / 跌停', value: `${data.limit.limit_up} / ${data.limit.limit_down}`, sub: `封板率 ${(data.limit.seal_rate ?? 0).toFixed(0)}%` },
    { label: '市场情绪', value: `${data.emotion.score}`, sub: data.emotion.label },
  ], [data])

  const runAI = () => {
    if (generating) return
    const holdingsContext = (portfolio.data?.items ?? []).slice(0, 30).map(item =>
      `${item.name || item.symbol}(${item.symbol}) 涨跌${item.change_pct == null ? '未知' : `${item.change_pct.toFixed(2)}%`} 板块${item.board?.name || '未关联'}`,
    ).join('；')
    const candidateContext = recommendationRows.slice(0, 12).map(item =>
      `${item.name || item.symbol}(${item.symbol}) 涨跌${item.change_pct == null ? '未知' : `${item.change_pct.toFixed(2)}%`} 成交额${amount(item.amount)}`,
    ).join('；')
    const focus = [
      '只基于给定的真实行情、量能、涨跌家数和板块数据分析，不允许编造缺失数据。重点分析大盘走势、成交额、量能变化、科技成长与防守风格，并给出上行/震荡/下行条件。',
      `当前选中指数：${selected.name}；四个指数量能摘要：${indexVolumeStats.map(row => `${row.name}成交额${amount(row.current)}、较近20日中位数${pct(row.change)}、全天外推${amount(row.forecast)}`).join('；')}`,
      `市场涨跌家数：上涨${data.breadth.up}、平盘${data.breadth.flat}、下跌${data.breadth.down}；强势板块：${strongSectors.map(row => `${row.name} ${pct(row.avg_pct)}`).join('、') || '暂无'}`,
      candidateContext ? `仅把以下真实榜单标的作为候选观察，不要把它们直接写成买入建议：${candidateContext}` : '当前没有可核验候选股榜单，明确写出数据不足。',
      holdingsContext ? `必须结合我的持仓逐只分析与市场和所属板块的同步/背离：${holdingsContext}` : '当前没有已核验持仓时，明确说明无法做持仓关联分析。',
      '请严格按“市场结论｜量能证据｜指数分化｜强势板块与候选股观察｜上行条件｜下行条件｜策略”输出；策略只能是条件化观察，不给出自动下单指令。',
    ].join('\n')
    void startReviewGeneration(undefined, focus)
    setForecastTab('ai')
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface/90 p-3 shadow-[0_1px_2px_hsl(var(--border)/0.4)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LineChart className="h-4 w-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">大盘走势与量能</h2>
            <p className="text-[10px] text-muted">先看指数走势，再看量能和预测；预测不等于交易指令</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted">
          <label className="inline-flex items-center gap-1">交易日<input aria-label="大盘走势交易日" type="date" value={selectedDate} max={new Date().toISOString().slice(0, 10)} onChange={event => setSelectedDate(event.target.value)} className="rounded border border-border bg-base px-1 py-0.5 text-[10px] text-foreground" /></label>
          <span>{minute.data?.date ?? data.as_of ?? '最新交易日'}</span>
          <span>{sourceText}</span>
          <Link to="/indices" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink className="h-3 w-3" />详细指数</Link>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5 md:grid-cols-4">
        {INDEXES.map(item => {
          const quote = data.indices.find(index => index.symbol === item.symbol)
          const volumeStats = indexVolumeStats.find(row => row.symbol === item.symbol)
          const active = item.symbol === selectedSymbol
          return <button key={item.symbol} type="button" onClick={() => setSelectedSymbol(item.symbol)} className={cn('rounded border px-2 py-1.5 text-left transition-colors', active ? 'border-accent/70 bg-accent/10' : 'border-border bg-elevated/40 hover:border-accent/40')}>
            <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{item.name}</span><span className={cn('font-mono text-xs', tone(quote?.change_pct))}>{pct(quote?.change_pct)}</span></div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2"><span className="font-mono text-sm font-semibold">{quote?.last_price?.toFixed(2) ?? '—'}</span><span className="text-[9px] text-muted">{item.symbol}</span></div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-[9px] text-muted"><span>量 <b className="font-mono text-secondary">{amount(volumeStats?.current)}</b></span><span className={tone(volumeStats?.change)}>均值 <b className="font-mono">{pct(volumeStats?.change)}</b></span><span>预测 <b className="font-mono text-secondary">{amount(volumeStats?.forecast)}</b></span><span>进度 <b className="font-mono text-secondary">{volumeStats?.progress ? `${(volumeStats.progress * 100).toFixed(0)}%` : '—'}</b></span></div>
          </button>
        })}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_248px]">
        <div className="min-h-0 rounded border border-border bg-base/35 p-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <b>{selected.name} · 分时走势</b>
            <span className="flex items-center gap-2 text-[10px] text-muted">{chartRows.length ? `${chartRows.length}根分钟K · 可缩放` : minute.isLoading ? '读取中…' : '暂无分钟数据'}<button type="button" onClick={() => setExpanded(true)} disabled={!chartRows.length} className="rounded border border-accent/50 px-1.5 py-0.5 text-accent disabled:opacity-40">放大查看</button></span>
          </div>
          {chartRows.length ? <EChartsIntraday data={chartRows} height={380} date={minute.data?.date ?? undefined} showLimitLines={false} showAvgLine={false} /> : <div className="flex h-[380px] items-center justify-center text-xs text-muted">{minute.isLoading ? <><RefreshCw className="mr-1 h-3 w-3 animate-spin" />正在读取分钟走势…</> : '当前没有可用的分钟数据，请检查分钟数据源和交易日期'}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            <span>当前来源：{sourceText}</span>
            <span>最后时间：{chartRows.at(-1)?.datetime ?? '—'}</span>
            <span className="text-warning">非交易时段请勿将历史曲线当作实时行情</span>
          </div>
        </div>

        <div className="min-h-0 max-h-full space-y-2 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <div className="grid grid-cols-2 gap-1.5">
            {marketStats.map(item => <div key={item.label} className="rounded border border-border bg-elevated/45 p-2"><div className="text-[10px] text-muted">{item.label}</div><div className="mt-0.5 font-mono text-sm font-semibold">{item.value}</div><div className="text-[9px] text-secondary">{item.sub}</div></div>)}
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">预测中心</b><div className="flex items-center gap-2"><span className="text-[9px] text-muted">三种口径分开显示</span><button type="button" onClick={runAI} disabled={generating} className="inline-flex items-center gap-1 rounded border border-accent/60 px-1.5 py-0.5 text-[10px] text-accent disabled:opacity-50"><Bot className="h-3 w-3" />{generating ? '生成中…' : 'AI策略'}</button></div></div>
            <div className="mb-2 grid grid-cols-3 gap-1">
              {([['model', '量化模型', BarChart3], ['ai', '本地AI', Bot], ['public', '公共平台', Globe2] ] as const).map(([key, label, Icon]) => <button key={key} type="button" onClick={() => setForecastTab(key)} className={cn('inline-flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px]', forecastTab === key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted')}><Icon className="h-3 w-3" />{label}</button>)}
            </div>
            {forecastTab === 'model' && <div className="space-y-1.5 text-[11px]">
              {volume.data?.status === 'ok' ? <>
                <div className="grid grid-cols-3 gap-1"><span className="rounded bg-base p-1.5">当前累计<br /><b>{forecastText(volume.data?.current_cumulative_amount)}</b></span><span className="rounded bg-base p-1.5">预测全天<br /><b>{forecastText(volume.data?.forecast_amount)}</b></span><span className="rounded bg-base p-1.5">进度<br /><b>{forecastRatio == null ? '—' : `${((forecastRatio ?? 0) * 100).toFixed(1)}%`}</b></span></div>
                <p className="text-[10px] text-muted">区间 {forecastText(volume.data?.forecast_low)} – {forecastText(volume.data?.forecast_high)} · 样本 {volume.data?.sample_days ?? '—'}日 · {volume.data?.method ?? '历史同期比例中位数'}。</p>
                <p className="text-[10px] text-muted">来源：{volume.data?.source ?? '未标注'} · 覆盖 {volume.data?.covered_symbol_count ?? '—'}/{volume.data?.symbol_count ?? '—'}只。</p>
              </> : <p className="text-[10px] text-muted">{volume.isLoading ? '正在读取真实分钟成交额…' : volume.data?.reason ?? '预测暂不可用，需要当前日和至少3个可比交易日的分钟成交额。'}</p>}
            </div>}
            {forecastTab === 'ai' && <div className="space-y-1.5 text-[11px]">
              <button type="button" onClick={runAI} disabled={generating} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50"><Bot className="h-3 w-3" />{generating ? 'AI生成中…' : '生成本地AI预测'}</button>
              {review.error && <p className="text-danger">{review.error}</p>}
              {recentAI ? <p className="leading-relaxed text-secondary">{recentAI}{review.content.length > 420 ? '…' : ''}</p> : <p className="text-[10px] text-muted">点击生成后，AI会基于当前市场摘要、指数、量能和板块数据给出情景判断。结果会标明生成状态和有效性，不直接下单。</p>}
              <Link to="/review" className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline">进入完整AI复盘页 <ExternalLink className="h-3 w-3" /></Link>
            </div>}
            {forecastTab === 'public' && <div className="space-y-1.5 text-[11px]">
              <div className="flex items-start gap-1.5 rounded bg-base p-2"><Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" /><div><b>公共平台数据摘要</b><p className="mt-0.5 text-[10px] text-muted">当前公共数据用于行情、板块、竞价或龙虎榜事实展示；如果供应商没有明确预测字段，不把行情数据伪装成预测。</p></div></div>
              <div className="grid grid-cols-2 gap-1 text-[10px]"><span>指数：{publicIndex?.name ?? selected.name}<br /><b>{publicIndex?.last_price?.toFixed(2) ?? '—'} {pct(publicIndex?.change_pct)}</b></span><span>市场成交额<br /><b>{fmtBigNum(data.amount.total)}</b></span><span>上涨/下跌<br /><b>{data.breadth.up} / {data.breadth.down}</b></span><span>情绪<br /><b>{data.emotion.label} · {data.emotion.score}</b></span></div>
              <p className="text-[10px] text-muted">来源和延迟以数据源配置页为准。建议接入同花顺公共观点时单独增加provider、发布时间和原文链接字段。</p>
              <Link to="/settings?tab=data-sources" className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline"><Info className="h-3 w-3" />查看数据源配置</Link>
            </div>}
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">指数量能对比</b><span className="text-[9px] text-muted">分钟累计 / 近20日中位数</span></div>
            <div className="space-y-1.5">
              {indexVolumeStats.map(row => <button key={row.symbol} type="button" onClick={() => setSelectedSymbol(row.symbol)} className={cn('w-full rounded bg-base/70 p-1.5 text-left hover:bg-base', row.symbol === selectedSymbol && 'ring-1 ring-accent/60')}>
                <div className="flex items-center justify-between gap-2 text-[10px]"><b>{row.name}</b><span className={cn('font-mono', tone(row.change))}>{row.change == null ? '暂无基准' : `较均值 ${pct(row.change)}`}</span></div>
                <div className="mt-1 flex items-center gap-2 text-[9px] text-muted"><span>当前 {amount(row.current)}</span><span>外推 {amount(row.forecast)}</span><span>进度 {row.progress ? `${(row.progress * 100).toFixed(0)}%` : '—'}</span></div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-elevated"><div className={cn('h-full rounded', row.change != null && row.change >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: `${Math.min(100, Math.max(4, (row.progress || 0) * 100))}%` }} /></div>
              </button>)}
            </div>
            <p className="mt-1 text-[9px] text-muted">外推仅按当前真实分钟成交额与时间进度计算；缺少分钟或历史基准时明确显示暂无。</p>
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">涨跌家数与强势方向</b><span className="text-[9px] text-muted">{data.as_of ?? '最新'}</span></div>
            <div className="grid grid-cols-3 gap-1 text-center text-[10px]"><span className="rounded bg-bull/10 p-1.5 text-bull"><b className="block font-mono text-sm">{data.breadth.up}</b>上涨</span><span className="rounded bg-elevated p-1.5 text-muted"><b className="block font-mono text-sm">{data.breadth.flat}</b>平盘</span><span className="rounded bg-bear/10 p-1.5 text-bear"><b className="block font-mono text-sm">{data.breadth.down}</b>下跌</span></div>
            <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]"><span>强势上涨<br /><b className="font-mono text-bull">{data.breadth.strong_up ?? '—'}</b></span><span>强势下跌<br /><b className="font-mono text-bear">{data.breadth.strong_down ?? '—'}</b></span><span>涨停 / 跌停<br /><b className="font-mono">{data.limit.limit_up} / {data.limit.limit_down}</b></span><span>新高 / 新低<br /><b className="font-mono">{data.trend.new_high} / {data.trend.new_low}</b></span></div>
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">今日强势板块</b><Link to="/strong-sectors" className="text-[10px] text-accent hover:underline">查看全部</Link></div>
            <div className="space-y-1">{strongSectors.length ? strongSectors.map(row => <div key={`${row.name}-${row.source_field ?? ''}`} className="flex items-center justify-between gap-2 rounded bg-base/70 px-1.5 py-1 text-[10px]"><span className="truncate">{row.name}</span><span className="shrink-0 text-muted">{row.up_count}/{row.count}上涨</span><b className={cn('font-mono', tone(row.avg_pct))}>{pct(row.avg_pct)}</b></div>) : <p className="text-[10px] text-muted">暂无板块排名数据</p>}</div>
            <p className="mt-1 text-[9px] text-muted">突然拉升的板块先看个股是否同步；已有底仓时才考虑正T，未有底仓不追涨。</p>
          </div>
          <div className="rounded border border-warning/35 bg-warning/5 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs text-warning">实时异动股票</b><span className="text-[9px] text-muted">约5秒刷新 · 点击看个股/板块</span></div>
            {abnormalRows.length ? <div className="space-y-1">{abnormalRows.slice(0, 6).map(row => <button key={row.symbol} type="button" onClick={() => setFocusStock({ symbol: row.symbol, name: row.name })} className="w-full rounded bg-base/70 px-1.5 py-1 text-left hover:bg-elevated"><div className="flex items-center justify-between gap-2 text-[10px]"><span className="truncate font-medium">{row.name || row.symbol}<small className="ml-1 font-mono text-muted">{row.symbol}</small></span><b className={cn('font-mono', tone(row.change_pct))}>{pct(row.change_pct)}</b></div><div className="mt-0.5 flex items-center justify-between gap-2 text-[9px] text-muted"><span>{(row.signals ?? []).map(signal => SIGNAL_LABELS[signal] ?? signal).join(' · ') || '价格异动'}</span><span>量比 {row.vol_ratio_5d == null ? '—' : Number(row.vol_ratio_5d).toFixed(2)}</span></div></button>)}</div> : <p className="text-[10px] text-muted">当前没有可核验的盘中异动信号</p>}
            <p className="mt-1 text-[9px] text-warning/80">正T提醒：仅当你已有该赛道底仓、个股与板块同步走强且回踩承接明确时观察“冲高减、回踩接”；没有底仓不追，不自动下单。</p>
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">实时候选股滚动</b><span className="text-[9px] text-muted">涨幅 / 活跃 / 成交额交集</span></div>
            {recommendationRows.length ? <div className="overflow-hidden rounded bg-base/70"><div className="flex min-w-max gap-2 py-1.5" style={{ animation: 'market-recommendation-ticker 30s linear infinite' }}>{[...recommendationRows, ...recommendationRows].map((row, index) => <Link key={`${row.symbol}-${index}`} to={`/stock-analysis?symbol=${encodeURIComponent(row.symbol)}`} className="w-32 shrink-0 rounded border border-border/70 px-1.5 py-1 text-[10px] hover:border-accent/60"><div className="truncate font-medium">{row.name || row.symbol}</div><div className="mt-0.5 flex items-center justify-between gap-1"><span className="font-mono text-muted">{row.symbol}</span><b className={cn('font-mono', tone(row.change_pct))}>{pct(row.change_pct)}</b></div><div className="mt-0.5 text-[9px] text-muted">成交额 {amount(row.amount)}</div></Link>)}</div></div> : <p className="text-[10px] text-muted">暂无可核验候选股数据</p>}
            <p className="mt-1 text-[9px] text-muted">候选来自真实涨幅、活跃度和成交额榜单；AI复核会继续结合量价、板块与新闻，数据不足时不会编造。</p>
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs">重要新闻推送</b><Link to="/market-news" className="text-[10px] text-accent hover:underline">打开新闻中心</Link></div>
            {newsRows.length ? <div className="space-y-1">{newsRows.map((item, index) => <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noopener noreferrer" className="block rounded bg-base/70 px-1.5 py-1 text-[10px] hover:bg-elevated"><div className="line-clamp-2 leading-relaxed">{item.title}</div><div className="mt-0.5 flex items-center justify-between gap-2 text-[9px] text-muted"><span>{item.bias ?? '待判断'} · {item.sector_names?.slice(0, 2).join('、') || '市场'}</span><span>{item.source ?? '公开源'}</span></div></a>)}</div> : <p className="text-[10px] text-muted">新闻源暂未返回内容</p>}
            <p className="mt-1 text-[9px] text-muted">新闻只做事件线索，点击原文核对；AI策略会把新闻与量价、板块同步性一起复核。</p>
          </div>
        </div>
      </div>

      {expanded && chartRows.length > 0 && <div role="dialog" aria-modal="true" aria-label={`${selected.name}分时走势`} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4" onClick={() => setExpanded(false)}>
        <div className="w-full max-w-6xl rounded-card border border-border bg-surface p-3 shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="mb-2 flex items-center justify-between"><b>{selected.name} · {minute.data?.date ?? selectedDate} · 分时走势</b><button type="button" onClick={() => setExpanded(false)} className="rounded border border-border px-2 py-1 text-xs text-muted">关闭</button></div>
          <EChartsIntraday data={chartRows} height={560} date={minute.data?.date ?? undefined} showLimitLines={false} showAvgLine={false} />
        </div>
      </div>}

      {focusStock && <div role="dialog" aria-modal="true" aria-label={`${focusStock.name || focusStock.symbol}异动详情`} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4" onClick={() => setFocusStock(null)}>
        <div className="max-h-[92vh] w-full max-w-6xl overflow-auto rounded-card border border-border bg-surface p-3 shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="mb-2 flex items-center justify-between gap-2"><div><b>{focusStock.name || focusStock.symbol} · 异动详情</b><span className="ml-2 font-mono text-xs text-muted">{focusStock.symbol}</span></div><button type="button" onClick={() => setFocusStock(null)} className="rounded border border-border px-2 py-1 text-xs text-muted">关闭</button></div>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded border border-border bg-base/40 p-2"><div className="mb-1 flex items-center justify-between text-xs"><b>个股分时</b><span className="text-muted">{focusMinute.data?.source ?? '读取中'}</span></div>{focusMinute.data?.rows?.length ? <EChartsIntraday data={focusMinute.data.rows} height={310} date={focusMinute.data.date ?? undefined} showLimitLines={false} showAvgLine={false} /> : <div className="flex h-[310px] items-center justify-center text-xs text-muted">{focusMinute.isLoading ? '正在读取个股分时…' : '暂无个股分时数据'}</div>}</section>
            <section className="rounded border border-border bg-base/40 p-2"><div className="mb-1 flex items-center justify-between text-xs"><b>关联板块分时</b><span className="text-muted">{focusBoard.data?.board?.name ?? '板块待识别'}</span></div>{focusBoardRows.length ? <EChartsIntraday data={focusBoardRows} height={310} date={selectedDate || undefined} showLimitLines={false} showAvgLine={false} /> : <div className="flex h-[310px] items-center justify-center text-xs text-muted">{focusBoard.isLoading ? '正在读取关联板块…' : '暂未取得关联板块分时，请在个股详情中绑定板块'}</div>}</section>
          </div>
          <div className="mt-2 rounded border border-warning/35 bg-warning/5 p-2 text-[11px] leading-relaxed"><b className="text-warning">正T条件提醒：</b>只有你已有该赛道底仓，且个股与板块同步走强、冲高后出现明确回踩承接时，才把“冲高减仓、回踩接回”作为观察方案；没有底仓不追涨，数据不足时不生成策略。</div>
        </div>
      </div>}

      <style>{'@keyframes market-recommendation-ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }'}</style>
      {false && <div className="mt-3 rounded border border-border bg-base/35 p-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <b className="text-xs">我的持仓实时总览</b>
            <p className="text-[10px] text-muted">只展示当前接口返回的数据；未接入券商/QMT的数量、成本和盈亏不会被填成历史快照</p>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted">来源：{portfolio.data?.source ?? (portfolio.isLoading ? '读取中…' : '未标注')}</span>
            {portfolio.data?.account_verified
              ? <span className="text-bull">券商账户已核验</span>
              : <span className="text-warning">账户未核验</span>}
            <Link to="/myagent-quant" className="text-accent hover:underline">管理持仓</Link>
          </div>
        </div>
        {portfolio.isError && <p className="mb-2 text-[10px] text-danger">持仓接口读取失败，当前不显示数量、成本和盈亏。</p>}
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[860px] text-[10px]">
            <thead className="bg-elevated/60 text-muted"><tr>
              <th className="px-2 py-1.5 text-left font-medium">证券</th><th className="px-2 py-1.5 text-right font-medium">现价</th>
              <th className="px-2 py-1.5 text-right font-medium">涨跌幅</th><th className="px-2 py-1.5 text-right font-medium">数量</th>
              <th className="px-2 py-1.5 text-right font-medium">成本</th><th className="px-2 py-1.5 text-right font-medium">浮盈亏</th>
              <th className="px-2 py-1.5 text-left font-medium">板块</th><th className="px-2 py-1.5 text-left font-medium">状态</th>
            </tr></thead>
            <tbody>
              {(portfolio.data?.items ?? []).map(item => <tr key={item.symbol} className="border-t border-border/70 hover:bg-elevated/40">
                <td className="px-2 py-1.5"><b>{item.name}</b><span className="ml-1 font-mono text-muted">{item.symbol}</span></td>
                <td className="px-2 py-1.5 text-right font-mono">{item.price == null ? '—' : item.price.toFixed(3)}</td>
                <td className={cn('px-2 py-1.5 text-right font-mono', tone(item.change_pct))}>{pct(item.change_pct)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{item.quantity == null ? '未录入' : item.quantity.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right font-mono">{item.cost == null ? '未录入' : item.cost.toFixed(3)}</td>
                <td className={cn('px-2 py-1.5 text-right font-mono', tone(item.pnl))}>{item.pnl == null ? '未核算' : item.pnl.toFixed(2)}</td>
                <td className="px-2 py-1.5">{item.board?.name ?? '待关联'}</td>
                <td className="px-2 py-1.5 text-muted">{item.holding_source ? '已录入持仓' : '监控标的·待核实'}</td>
              </tr>)}
            </tbody>
          </table>
          {!portfolio.isLoading && !portfolio.data?.items?.length && <p className="p-3 text-center text-[10px] text-muted">暂无持仓或监控标的，请先进入“管理持仓”录入或核对。</p>}
        </div>
      </div>}
    </section>
  )
}

