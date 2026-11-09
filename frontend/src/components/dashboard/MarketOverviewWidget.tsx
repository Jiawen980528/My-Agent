import { useEffect, useMemo, useState } from 'react'
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

type BreadthPoint = { time: string; up: number; flat: number; down: number }

function BreadthTrend({ data }: { data: OverviewMarket }) {
  const [points, setPoints] = useState<BreadthPoint[]>([])
  useEffect(() => {
    const point = { time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), up: data.breadth.up, flat: data.breadth.flat, down: data.breadth.down }
    setPoints(current => {
      const last = current.at(-1)
      if (last && last.up === point.up && last.flat === point.flat && last.down === point.down) return current
      return [...current, point].slice(-48)
    })
  }, [data.breadth.down, data.breadth.flat, data.breadth.up])
  const max = Math.max(1, ...points.flatMap(point => [point.up, point.flat, point.down]))
  const path = (key: 'up' | 'flat' | 'down') => points.map((point, index) => {
    const x = points.length <= 1 ? 0 : index / (points.length - 1) * 100
    const y = 100 - point[key] / max * 92 - 4
    return `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  return <div className="rounded border border-border bg-base/35 p-2">
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <b className="text-xs">市场涨跌动态</b>
      <span className="text-[10px] text-muted">页面打开后每次刷新记录 · 最近 {points.length} 个观测点</span>
    </div>
    <div className="h-32 rounded bg-base/50 px-1 py-1">
      {points.length > 1 ? <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="上涨平盘下跌家数动态曲线">
        <path d={path('up')} fill="none" stroke="hsl(var(--bull))" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        <path d={path('flat')} fill="none" stroke="hsl(var(--fg-muted))" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        <path d={path('down')} fill="none" stroke="hsl(var(--bear))" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg> : <div className="flex h-full items-center justify-center text-[10px] text-muted">等待下一次市场数据刷新后绘制曲线</div>}
    </div>
    <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-muted"><span className="text-bull">● 上涨 {data.breadth.up}</span><span>● 平盘 {data.breadth.flat}</span><span className="text-bear">● 下跌 {data.breadth.down}</span></div>
  </div>
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
  const portfolio = useQuery({
    queryKey: ['dashboard-portfolio-snapshot'],
    queryFn: () => api.portfolioSnapshot(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const review = useReviewState()
  const generating = isReviewGenerating()
  const selected = INDEXES.find(item => item.symbol === selectedSymbol) ?? INDEXES[0]
  const publicIndex = data.indices.find(item => item.symbol === selectedSymbol)
  const recentAI = review.content.trim().replace(/[#*_`]/g, '').replace(/\s+/g, ' ').slice(0, 420)
  const chartRows = minute.data?.rows ?? []
  const forecastRatio = volume.data?.status === 'ok' && volume.data.forecast_amount
    ? (volume.data.current_cumulative_amount ?? 0) / volume.data.forecast_amount
    : null
  const sourceText = minute.data?.source ?? '分钟数据源未标注'
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
    const focus = [
      '重点分析大盘走势、成交额、量能变化、科技成长与防守风格，并给出上行/震荡/下行条件。',
      holdingsContext ? `必须结合我的持仓逐只分析与市场和所属板块的同步/背离：${holdingsContext}` : '当前没有已核验持仓时，明确说明无法做持仓关联分析。',
      '引用可用的历史交易日数据，区分当前行情、历史数据和推断，不给出自动下单指令。',
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
          <span>{minute.data?.date ?? data.as_of ?? '最新交易日'}</span>
          <span>{sourceText}</span>
          <Link to="/indices" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink className="h-3 w-3" />详细指数</Link>
        </div>
      </div>

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

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)]">
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

        <div className="min-h-0 max-h-full space-y-2 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <div className="grid grid-cols-2 gap-1.5">
            {marketStats.map(item => <div key={item.label} className="rounded border border-border bg-elevated/45 p-2"><div className="text-[10px] text-muted">{item.label}</div><div className="mt-0.5 font-mono text-sm font-semibold">{item.value}</div><div className="text-[9px] text-secondary">{item.sub}</div></div>)}
          </div>
          {false && <div className="rounded border border-border bg-elevated/35 p-2">
            <div className="mb-1 flex items-center justify-between"><b className="text-xs">预测中心</b><span className="text-[9px] text-muted">三种口径分开显示</span></div>
            <div className="mb-2 grid grid-cols-3 gap-1">
              {([['model', '量化模型', BarChart3], ['ai', '本地AI', Bot], ['public', '公共平台', Globe2] ] as const).map(([key, label, Icon]) => <button key={key} type="button" onClick={() => setForecastTab(key)} className={cn('inline-flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px]', forecastTab === key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted')}><Icon className="h-3 w-3" />{label}</button>)}
            </div>
            {forecastTab === 'model' && <div className="space-y-1.5 text-[11px]">
              {volume.data?.status === 'ok' ? <>
                <div className="grid grid-cols-3 gap-1"><span className="rounded bg-base p-1.5">当前累计<br /><b>{forecastText(volume.data.current_cumulative_amount)}</b></span><span className="rounded bg-base p-1.5">预测全天<br /><b>{forecastText(volume.data.forecast_amount)}</b></span><span className="rounded bg-base p-1.5">进度<br /><b>{forecastRatio == null ? '—' : `${(forecastRatio * 100).toFixed(1)}%`}</b></span></div>
                <p className="text-[10px] text-muted">区间 {forecastText(volume.data.forecast_low)} – {forecastText(volume.data.forecast_high)} · 样本 {volume.data.sample_days ?? '—'}日 · {volume.data.method ?? '历史同期比例中位数'}。</p>
                <p className="text-[10px] text-muted">来源：{volume.data.source ?? '未标注'} · 覆盖 {volume.data.covered_symbol_count ?? '—'}/{volume.data.symbol_count ?? '—'}只。</p>
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
          </div>}
        </div>
      </div>

      {false && <div className="mt-3"><BreadthTrend data={data} /></div>}

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

