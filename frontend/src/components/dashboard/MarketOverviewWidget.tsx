import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { BarChart3, Bot, ExternalLink, Globe2, Info, LineChart, RefreshCw } from 'lucide-react'
import { EChartsIntraday } from '@/components/EChartsIntraday'
import { api, type OverviewMarket } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { startReviewGeneration, isReviewGenerating } from '@/lib/reviewStore'
import { useReviewState } from '@/lib/useReviewStore'
import { fmtBigNum } from '@/lib/format'
import { cn } from '@/lib/cn'

const FORECAST_REVIEW_API = '/quant/api/myagent/forecast-review'
type ForecastReviewItem = { id: string; trade_date: string; scope?: string; forecast_amount?: number; forecast_low?: number; forecast_high?: number; actual_amount?: number; status?: 'pending' | 'hit' | 'miss'; as_of?: string; source?: string }

const INDEXES = [
  { symbol: '000001.SH', name: '上证指数' },
  { symbol: '399001.SZ', name: '深证成指' },
  { symbol: '399006.SZ', name: '创业板指' },
  { symbol: '000688.SH', name: '科创50' },
]

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

function marketState(data: OverviewMarket, chartRows: Array<{ close?: number }>) {
  const avg = Number(data.breadth.avg_pct)
  const up = Number(data.breadth.up || 0)
  const down = Number(data.breadth.down || 0)
  const values = chartRows.map(row => Number(row.close)).filter(Number.isFinite)
  const intraday = values.length >= 2 && values[0] > 0 ? (values.at(-1)! / values[0] - 1) * 100 : null
  if (!Number.isFinite(avg) || !data.breadth.total) return { label: '数据不足', detail: '等待真实市场广度和指数分钟数据', cls: 'text-muted' }
  if (avg <= -0.5 && down > up * 1.2) return { label: '继续下跌', detail: '广度偏弱，暂不把盘中波动当作反转', cls: 'text-bear' }
  if (avg >= 0.5 && up > down * 1.5 && (intraday == null || intraday > 0)) {
    return { label: intraday != null && intraday >= 0.8 ? '反转待确认' : '反弹观察', detail: '上涨广度占优，仍需量能和板块同步确认', cls: 'text-bull' }
  }
  return { label: '震荡', detail: '多空未形成一致方向，优先等待支撑/压力确认', cls: 'text-warning' }
}

function armsLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '不可用'
  return value.toFixed(2)
}

export function MarketOverviewWidget({ data, tradeDate }: { data: OverviewMarket; tradeDate?: string }) {
  const [selectedSymbol, setSelectedSymbol] = useState(INDEXES[0].symbol)
  const [forecastTab, setForecastTab] = useState<'model' | 'ai' | 'public'>('model')
  const minute = useQuery({
    queryKey: ['dashboard-market-index-minute', selectedSymbol, tradeDate ?? 'latest'],
    queryFn: () => api.indexMinute(selectedSymbol, tradeDate),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const volume = useQuery({
    queryKey: QK.marketVolumeForecast(tradeDate),
    queryFn: () => api.marketVolumeForecast(tradeDate),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const forecastReviews = useQuery({
    queryKey: ['dashboard-forecast-reviews'],
    queryFn: async () => {
      const response = await fetch(FORECAST_REVIEW_API, { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<{ items?: ForecastReviewItem[]; summary?: { resolved?: number; success_rate?: number | null; pending?: number } }>
    },
    staleTime: 60_000,
  })
  const [forecastReviewMessage, setForecastReviewMessage] = useState('')
  const [actualAmounts, setActualAmounts] = useState<Record<string, string>>({})
  const portfolio = useQuery({
    queryKey: ['dashboard-portfolio-snapshot'],
    queryFn: () => api.portfolioSnapshot(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const externalMarket = useQuery({
    queryKey: ['dashboard-external-market-context'],
    queryFn: api.externalMarketContext,
    refetchInterval: 180_000,
    staleTime: 120_000,
  })
  const review = useReviewState()
  const generating = isReviewGenerating()
  const selected = INDEXES.find(item => item.symbol === selectedSymbol) ?? INDEXES[0]
  const publicIndex = data.indices.find(item => item.symbol === selectedSymbol)
  const hasMarketSnapshot = Boolean(
    data.breadth.total > 0 ||
    data.indices.some(index => index.last_price != null || index.change_pct != null) || data.amount.total > 0,
  )
  const recentAI = review.content.trim().replace(/[#*_`]/g, '').replace(/\s+/g, ' ').slice(0, 420)
  const chartRows = minute.data?.rows ?? []
  const forecastRatio = volume.data?.status === 'ok' && volume.data.forecast_amount
    ? (volume.data.current_cumulative_amount ?? 0) / volume.data.forecast_amount
    : null
  const sourceText = minute.data?.source ?? data.quote_status?.source ?? '分钟数据源未标注'
  const state = marketState(data, chartRows)
  const marketStats = useMemo(() => [
    { label: '今日市场状态', value: state.label, sub: state.detail, cls: state.cls },
    { label: '当前成交额', value: hasMarketSnapshot ? fmtBigNum(data.amount.total) : '不可用', sub: hasMarketSnapshot ? '点击右侧预测' : '未连接实时行情', cls: 'text-foreground' },
    { label: '上涨 / 下跌', value: hasMarketSnapshot ? `${data.breadth.up} / ${data.breadth.down}` : '不可用', sub: hasMarketSnapshot ? `上涨率 ${data.breadth.up_pct.toFixed(1)}%` : '未取得市场广度', cls: 'text-foreground' },
    { label: '涨停 / 跌停', value: hasMarketSnapshot ? `${data.limit.limit_up} / ${data.limit.limit_down}` : '不可用', sub: hasMarketSnapshot ? `封板率 ${(data.limit.seal_rate ?? 0).toFixed(0)}%` : '未取得涨跌停数据', cls: 'text-foreground' },
    { label: '市场情绪', value: hasMarketSnapshot ? `${data.emotion.score}` : '不可用', sub: hasMarketSnapshot ? data.emotion.label : '未取得市场情绪', cls: 'text-foreground' },
    { label: '阿姆斯 / TRIN', value: armsLabel(data.arms?.value), sub: data.arms?.status === 'ok' ? (Number(data.arms.value) >= 1 ? '量能偏向下跌' : '量能偏向上涨') : '缺少真实上涨/下跌成交量', cls: data.arms?.value == null ? 'text-muted' : Number(data.arms.value) >= 1 ? 'text-bear' : 'text-bull' },
  ], [data, hasMarketSnapshot, state.label, state.detail, state.cls])

  const runAI = () => {
    if (generating) return
    const externalText = externalMarket.data?.rows?.length
      ? externalMarket.data.rows.map(row => `${row.name} ${row.last == null ? '不可用' : row.last.toFixed(2)} ${pct(row.change_pct)}`).join('；')
      : '美股/外围公共行情暂不可用，不得据此推断';
    const forecastHistory = forecastReviews.data?.summary
      ? `历史成交额预测复盘：已复盘 ${forecastReviews.data.summary.resolved ?? 0} 次，成功率 ${forecastReviews.data.summary.success_rate == null ? '暂无' : `${forecastReviews.data.summary.success_rate}%`}，待复盘 ${forecastReviews.data.summary.pending ?? 0} 次。`
      : '历史成交额预测复盘数据暂不可用。'
    void startReviewGeneration(undefined, `重点分析大盘走势、成交额、量能变化、科技成长与防守风格，并给出上行/震荡/下行条件。外围背景（公共行情，可能延迟）：${externalText}。${forecastHistory} 仅将历史复盘作为证据，不得把它当作实时数据，也不得据此编造交易信号。`)
    setForecastTab('ai')
  }

  const saveForecastReview = async () => {
    if (volume.data?.status !== 'ok' || !volume.data.forecast_amount) return
    const reviewTradeDate = volume.data.trade_date ?? tradeDate ?? data.as_of
    if (!reviewTradeDate) { setForecastReviewMessage('缺少交易日，未保存'); return }
    setForecastReviewMessage('保存中…')
    try {
      const response = await fetch(FORECAST_REVIEW_API, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade_date: reviewTradeDate,
          scope: '全市场',
          forecast_amount: volume.data.forecast_amount,
          forecast_low: volume.data.forecast_low,
          forecast_high: volume.data.forecast_high,
          current_cumulative_amount: volume.data.current_cumulative_amount,
          as_of: volume.data.as_of,
          source: volume.data.source,
          method: volume.data.method,
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setForecastReviewMessage('已记录，收盘后可复盘')
      await forecastReviews.refetch()
    } catch (error) {
      setForecastReviewMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败')
    }
  }

  const resolveForecastReview = async (id: string) => {
    const actual = Number(actualAmounts[id])
    if (!Number.isFinite(actual) || actual <= 0) { setForecastReviewMessage('请输入真实收盘成交额'); return }
    setForecastReviewMessage('复盘中…')
    try {
      const response = await fetch(`${FORECAST_REVIEW_API}/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual_amount: actual }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setForecastReviewMessage('已完成复盘')
      await forecastReviews.refetch()
    } catch (error) {
      setForecastReviewMessage(error instanceof Error ? `复盘失败：${error.message}` : '复盘失败')
    }
  }

  return (
    <section className="h-full overflow-hidden rounded-card border border-border bg-surface/90 p-3 shadow-[0_1px_2px_hsl(var(--border)/0.4)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LineChart className="h-4 w-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">大盘走势与量能</h2>
            <p className="text-[10px] text-muted">先看指数走势，再看量能和预测；预测不等于交易指令</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted">
          <span>{minute.data?.date ?? data.as_of ?? '最新交易日'}</span>
          <span>{sourceText}</span>
          <Link to="/indices" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink className="h-3 w-3" />详细指数</Link>
        </div>
      </div>
      {!hasMarketSnapshot && <div role="status" className="mb-2 rounded border border-warning/50 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
        实时市场快照当前不可用：TickFlow行情服务未连接或没有可用权限。页面不会把 0 当作真实上涨、涨停或成交额；请到数据源配置页检查连接和更新时间。
        <Link to="/settings?tab=data-sources" className="ml-1 text-accent hover:underline">检查数据源</Link>
      </div>}

      <div className="mb-2 grid grid-cols-2 gap-1.5 md:grid-cols-4">
        {INDEXES.map(item => {
          const quote = data.indices.find(index => index.symbol === item.symbol)
          const active = item.symbol === selectedSymbol
          return <button key={item.symbol} type="button" onClick={() => setSelectedSymbol(item.symbol)} className={cn('rounded border px-2 py-1.5 text-left transition-colors', active ? 'border-accent/70 bg-accent/10' : 'border-border bg-elevated/40 hover:border-accent/40')}>
            <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{item.name}</span><span className={cn('font-mono text-xs', tone(quote?.change_pct))}>{pct(quote?.change_pct)}</span></div>
            <div className="mt-0.5 font-mono text-sm">{quote?.last_price?.toFixed(2) ?? '—'}</div>
            <div className="text-[9px] text-muted">{item.symbol}</div>
          </button>
        })}
      </div>

      <div className="mb-2 rounded border border-border bg-elevated/30 p-2">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5"><Globe2 className="h-3.5 w-3.5 text-accent" /><b className="text-xs">美股 / 外围影响</b><span className="text-[10px] text-muted">仅作背景参考，不混入 A 股资金流</span></div>
          <span className="text-[9px] text-muted">{externalMarket.data?.source ?? (externalMarket.isLoading ? '读取中…' : '公共源不可用')}</span>
        </div>
        {externalMarket.data?.rows?.length ? <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
          {externalMarket.data.rows.map(row => <div key={row.symbol} className="rounded border border-border/70 bg-base/45 px-2 py-1.5">
            <div className="flex items-center justify-between gap-1"><span className="text-[10px] text-muted">{row.name}</span><span className={cn('font-mono text-xs', tone(row.change_pct))}>{pct(row.change_pct)}</span></div>
            <div className="font-mono text-sm">{row.last == null ? '—' : row.last.toFixed(2)}</div>
            <div className="text-[9px] text-muted">{row.as_of ? new Date(row.as_of).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '无时间戳'} · {row.status === 'ok' ? '可用' : '不可用'}</div>
          </div>)}
        </div> : <div className="rounded bg-warning/10 px-2 py-1.5 text-[10px] text-warning">外围公共行情暂不可用；不会用 0 或 A 股数据代替。{externalMarket.data?.errors?.length ? ` ${externalMarket.data.errors.join('；')}` : ''}</div>}
        <div className="mt-1 text-[9px] text-muted">{externalMarket.data?.notice ?? '未取得外围行情状态。'} 抓取：{externalMarket.data?.generated_at ?? '—'}</div>
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)]">
        <div className="min-h-0 rounded border border-border bg-base/35 p-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <b>{selected.name} · 分时走势</b>
            <span className="text-[10px] text-muted">{chartRows.length ? `${chartRows.length}根分钟K · 可缩放` : minute.isLoading ? '读取中…' : '暂无分钟数据'}</span>
          </div>
          {chartRows.length ? <EChartsIntraday data={chartRows} height={300} date={minute.data?.date ?? undefined} showLimitLines={false} showAvgLine /> : <div className="flex h-[300px] items-center justify-center text-xs text-muted">{minute.isLoading ? <><RefreshCw className="mr-1 h-3 w-3 animate-spin" />正在读取分钟走势…</> : '当前没有可用的分钟数据，请检查分钟数据源和交易日期'}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            <span>当前来源：{sourceText}</span>
            <span>最后时间：{chartRows.at(-1)?.datetime ?? '—'}</span>
            <span className="text-warning">非交易时段请勿将历史曲线当作实时行情</span>
          </div>
        </div>

        <div className="min-h-0 space-y-2 overflow-auto">
          <div className="grid grid-cols-2 gap-1.5">
            {marketStats.map(item => <div key={item.label} className="rounded border border-border bg-elevated/45 p-2"><div className="text-[10px] text-muted">{item.label}</div><div className={cn('mt-0.5 font-mono text-sm font-semibold', item.cls)}>{item.value}</div><div className="text-[9px] text-secondary">{item.sub}</div></div>)}
          </div>
          <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1"><b className="text-xs">预测中心</b><span className="text-[9px] text-muted">三种口径分开显示 · 预测时段：当前时点 → 当日收盘</span></div>
            <div className="mb-2 grid grid-cols-3 gap-1">
              {([['model', '量化模型', BarChart3], ['ai', '本地AI', Bot], ['public', '公共平台', Globe2] ] as const).map(([key, label, Icon]) => <button key={key} type="button" onClick={() => setForecastTab(key)} className={cn('inline-flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px]', forecastTab === key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted')}><Icon className="h-3 w-3" />{label}</button>)}
            </div>
            {forecastTab === 'model' && <div className="space-y-1.5 text-[11px]">
              {volume.data?.status === 'ok' ? <>
                <div className="grid grid-cols-3 gap-1"><span className="rounded bg-base p-1.5">当前累计<br /><b>{forecastText(volume.data.current_cumulative_amount)}</b></span><span className="rounded bg-base p-1.5">预测全天<br /><b>{forecastText(volume.data.forecast_amount)}</b></span><span className="rounded bg-base p-1.5">进度<br /><b>{forecastRatio == null ? '—' : `${(forecastRatio * 100).toFixed(1)}%`}</b></span></div>
                <p className="text-[10px] text-muted">区间 {forecastText(volume.data.forecast_low)} – {forecastText(volume.data.forecast_high)} · 样本 {volume.data.sample_days ?? '—'}日 · {volume.data.method ?? '历史同期比例中位数'}。</p>
                <p className="text-[10px] text-muted">来源：{volume.data.source ?? '未标注'} · 覆盖 {volume.data.covered_symbol_count ?? '—'}/{volume.data.symbol_count ?? '—'}只 · 截至 {volume.data.as_of ?? '—'} · 生成 {volume.data.generated_at ?? '—'}。</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
                  <button type="button" onClick={saveForecastReview} className="rounded border border-accent/50 px-1.5 py-0.5 text-accent hover:bg-accent/10">记录本次预测</button>
                  <span className="text-muted">已复盘 {forecastReviews.data?.summary?.resolved ?? 0} 次 · 成功率 {forecastReviews.data?.summary?.success_rate == null ? '—' : `${forecastReviews.data.summary.success_rate}%`}</span>
                  {forecastReviewMessage && <span className="text-secondary">{forecastReviewMessage}</span>}
                </div>
                {!!forecastReviews.data?.items?.length && <div className="mt-1 max-h-28 space-y-1 overflow-auto border-t border-border/50 pt-1 text-[10px]">
                  {forecastReviews.data.items.slice(0, 4).map(item => <div key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded bg-base/60 px-1.5 py-1">
                    <span className="font-mono text-muted">{item.trade_date}</span>
                    <span>预测 {forecastText(item.forecast_amount)}</span>
                    <span className={item.status === 'hit' ? 'text-bull' : item.status === 'miss' ? 'text-bear' : 'text-warning'}>{item.status === 'hit' ? '命中' : item.status === 'miss' ? '未命中' : '待复盘'}</span>
                    {item.status === 'pending' ? <><input aria-label={`${item.trade_date}真实收盘成交额`} value={actualAmounts[item.id] || ''} onChange={event => setActualAmounts(current => ({ ...current, [item.id]: event.target.value }))} placeholder="真实收盘额" inputMode="decimal" className="w-24 rounded border border-border bg-surface px-1 py-0.5" /><button type="button" onClick={() => resolveForecastReview(item.id)} className="text-accent">复盘</button></> : <span className="text-muted">实际 {forecastText(item.actual_amount)}</span>}
                  </div>)}
                </div>}
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
        </div>
      </div>

      <div className="mt-3 rounded border border-border bg-base/35 p-2">
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
      </div>
    </section>
  )
}

