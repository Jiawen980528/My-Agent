/**
 * 看板组件注册表 — 每个可摆放组件的类型、标签、图标、尺寸约束与渲染。
 *
 * render(ctx, item?) 输出该组件的完整卡片(自带边框/标题, 与抽离前视觉一致);
 * DashboardGrid 负责定位/拖拽/缩放壳, 不感知具体组件内部。
 */
import type { CSSProperties } from 'react'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BellRing, Flame, Gauge, LineChart, Link2, Sparkles, Target, TrendingUp, TrendingDown, Coins, Repeat } from 'lucide-react'
import { api, type AlertEvent, type MarketSnapshotRow, type OverviewMarket } from '@/lib/api'
import { fmtBigNum } from '@/lib/format'
import type { DimensionMembersTarget } from '@/components/DimensionMembersDialog'
import { SealedBadge } from '@/components/SealedBadge'
import { scoreColor, fmtPrice, fmtStockPct, pctClass, compactCount, SectionTitle, MiniMetric, KpiCell } from './shared'
import { EmotionScoreConfigDialog } from './EmotionScoreConfigDialog'
import {
  IndexTickerList, BreadthBar, DistributionBars, EmotionRadar, LadderMini, StockList, HotRankCard, MonitorWidget,
  stockListNav, rankNav,
} from './widgets'
import type { DashboardItem, WidgetType } from './layout'
import { ExternalLinkWidget } from './ExternalLinkWidget'
import { FundFlowPanel } from '@/components/FundFlowPanel'
import { HoldingsWidget, SectorWatchWidget, MarketNewsWidget } from './MyAgentWidgets'
import { PortfolioMonitorWidget } from './PortfolioMonitorWidget'
import { PageWidget } from './PageWidget'
import { MarketOverviewWidget } from './MarketOverviewWidget'

/** 渲染上下文: 数据切片与交互回调(由 Dashboard 页提供, 组件不自取数据) */
export interface WidgetCtx {
  data: OverviewMarket
  score: number
  hasDepth: boolean
  sealedReady: boolean
  isSealedDegrade: boolean
  /** 来源榜当前选中的 symbol (StockPreviewDialog 高亮), source 如 'gain' | 'concept' | 'alert' */
  activeSymbol: (source: string) => string | undefined
  openStock: (source: string, symbol: string, name?: string, navList?: { symbol: string; name?: string }[]) => void
  openDimension: (t: DimensionMembersTarget) => void
  openAlert: (ev: AlertEvent, navList?: { symbol: string; name?: string }[]) => void
}

export interface WidgetDef {
  id: WidgetType
  label: string
  icon: typeof Flame
  minW: number
  minH: number
  /** 默认尺寸(添加新实例时), 布局默认坐标在 DEFAULT_LAYOUT */
  defW: number
  defH: number
  render: (ctx: WidgetCtx, item: DashboardItem) => ReactNode
}

function sectionCard(children: ReactNode, opts: { className?: string; style?: CSSProperties } = {}): ReactNode {
  return (
    <section
      style={opts.style}
      className={`h-full overflow-hidden rounded-card border border-border bg-surface/80 p-1.5 shadow-[0_1px_2px_hsl(var(--border)/0.4)] backdrop-blur-sm transition-shadow hover:shadow-[0_2px_8px_hsl(var(--border)/0.5)] ${opts.className ?? ''}`}
    >
      {children}
    </section>
  )
}

/** 情绪雷达卡片 — 自带评分口径配置入口 (齿轮 → 对话框)。
 *  单独成组件是因为对话框开关是卡片级状态, 不放进全局 WidgetCtx。 */
function EmotionRadarCard({ ctx }: { ctx: WidgetCtx }) {
  const [configOpen, setConfigOpen] = useState(false)
  return (
    <>
      {sectionCard(
        <>
          <SectionTitle
            icon={Sparkles}
            title="情绪雷达"
            hint={`情绪评分 ${ctx.score}`}
            onConfig={() => setConfigOpen(true)}
            configTitle="配置情绪评分的计算方式"
          />
          <EmotionRadar radar={ctx.data.radar} score={ctx.score} />
        </>,
        { style: { borderColor: `${scoreColor(ctx.score)}40` } },
      )}
      {configOpen && <EmotionScoreConfigDialog onClose={() => setConfigOpen(false)} />}
    </>
  )
}

function KpiWidget({ ctx }: { ctx: WidgetCtx }) {
  const { data, hasDepth, isSealedDegrade, sealedReady } = ctx
  const [selectedMetric, setSelectedMetric] = useState<number | null>(null)
  const [selectedBucket, setSelectedBucket] = useState('')
  const [metricSearch, setMetricSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(200)
  const snapshot = useQuery({ queryKey: ['market-snapshot'], queryFn: api.marketSnapshot, enabled: selectedMetric != null, staleTime: 30_000 })
  const strongUp = data.breadth.strong_up ?? 0
  const strongDown = data.breadth.strong_down ?? 0
  const names = ['个股涨 / 平 / 跌', '强势 / 弱势', '涨停 / 跌停', '最高连板', '成交额', '换手 / 量比']
  const buckets = selectedMetric === 0 ? ['上涨', '平盘', '下跌'] : selectedMetric === 1 ? ['强势≥3%', '弱势≤-3%']
    : selectedMetric === 2 ? ['涨停', '跌停', '炸板'] : selectedMetric === 3 ? [`${data.limit.max_boards || 0}板`]
      : selectedMetric === 4 ? ['成交额排行'] : ['高换手≥5%', '放量≥1.5倍']
  const activeBucket = selectedBucket || buckets[0]
  const metricRows = useMemo(() => {
    if (selectedMetric == null) return []
    const rows = [...(snapshot.data?.rows || [])]
    const value = (row: MarketSnapshotRow, key: string) => Number(row[key] ?? 0)
    let filtered = rows.filter(row => {
      const change = Number(row.change_pct ?? 0)
      if (selectedMetric === 0) return activeBucket === '上涨' ? change > 0 : activeBucket === '下跌' ? change < 0 : change === 0
      if (selectedMetric === 1) return activeBucket.startsWith('强势') ? change >= .03 : change <= -.03
      if (selectedMetric === 2) return activeBucket === '涨停' ? Boolean(row.signal_limit_up) || value(row, 'consecutive_limit_ups') > 0
        : activeBucket === '跌停' ? Boolean(row.signal_limit_down) : Boolean(row.signal_broken_limit_up)
      if (selectedMetric === 3) return value(row, 'consecutive_limit_ups') === data.limit.max_boards
      if (selectedMetric === 5) return activeBucket.startsWith('高换手') ? value(row, 'turnover_rate') >= 5 : value(row, 'vol_ratio_5d') >= 1.5
      return true
    })
    const query = metricSearch.trim().toLowerCase()
    if (query) filtered = filtered.filter(row => `${row.symbol} ${row.name || ''}`.toLowerCase().includes(query))
    const key = selectedMetric === 4 ? 'amount' : selectedMetric === 5 && activeBucket.startsWith('高换手') ? 'turnover_rate'
      : selectedMetric === 5 ? 'vol_ratio_5d' : selectedMetric === 3 ? 'consecutive_limit_ups' : 'change_pct'
    return filtered.sort((a, b) => activeBucket === '下跌' || activeBucket.startsWith('弱势') || activeBucket === '跌停'
      ? value(a, key) - value(b, key) : value(b, key) - value(a, key))
  }, [selectedMetric, activeBucket, snapshot.data?.rows, metricSearch, data.limit.max_boards])
  const openMetric = (index: number) => { setSelectedMetric(index); setSelectedBucket(''); setMetricSearch(''); setVisibleCount(200) }
  return (
    <div className="grid h-full grid-cols-3 gap-1 xl:grid-cols-6">
      {selectedMetric != null && <div role="dialog" aria-label="市场指标成分明细" className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-3" onClick={() => setSelectedMetric(null)}><div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-card border border-border bg-surface p-3 text-sm shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><b>{names[selectedMetric]} · 股票明细</b><span className="ml-2 text-xs text-muted">数据日 {snapshot.data?.as_of || data.as_of || '—'} · 共 {metricRows.length} 只</span></div><button type="button" onClick={() => setSelectedMetric(null)} className="rounded border border-border px-2 py-1">关闭</button></div>
        <div className="mt-2 flex flex-wrap items-center gap-1">{buckets.map(bucket => <button key={bucket} type="button" onClick={() => { setSelectedBucket(bucket); setVisibleCount(200) }} className={`rounded border px-2 py-1 text-xs ${activeBucket === bucket ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted'}`}>{bucket}</button>)}<input value={metricSearch} onChange={event => { setMetricSearch(event.target.value); setVisibleCount(200) }} placeholder="搜索股票名称或代码" className="ml-auto min-w-48 rounded border border-border bg-base px-2 py-1 text-xs" /></div>
        <div className="mt-2 min-h-0 flex-1 overflow-auto rounded border border-border"><table className="w-full min-w-[720px] text-xs"><thead className="sticky top-0 z-10 bg-elevated text-muted"><tr>{['股票','最新','涨跌幅','成交额','换手率','量比','连板'].map(label => <th key={label} className="px-2 py-2 text-left">{label}</th>)}</tr></thead><tbody>{metricRows.slice(0, visibleCount).map(row => <tr key={row.symbol} onClick={() => { setSelectedMetric(null); ctx.openStock(selectedMetric === 4 ? 'amount' : selectedMetric === 5 ? 'active' : Number(row.change_pct) < 0 ? 'loss' : 'gain', row.symbol, row.name || undefined, metricRows.map(item => ({ symbol: item.symbol, name: item.name || undefined }))) }} className="cursor-pointer border-t border-border/60 hover:bg-elevated"><td className="px-2 py-1.5"><b>{row.name || row.symbol}</b><span className="ml-2 font-mono text-muted">{row.symbol}</span></td><td className="px-2 py-1.5 font-mono">{fmtPrice(row.close)}</td><td className={`px-2 py-1.5 font-mono ${pctClass(row.change_pct)}`}>{fmtStockPct(row.change_pct)}</td><td className="px-2 py-1.5 font-mono">{fmtBigNum(Number(row.amount || 0))}</td><td className="px-2 py-1.5 font-mono">{row.turnover_rate == null ? '—' : `${Number(row.turnover_rate).toFixed(2)}%`}</td><td className="px-2 py-1.5 font-mono">{row.vol_ratio_5d == null ? '—' : Number(row.vol_ratio_5d).toFixed(2)}</td><td className="px-2 py-1.5 font-mono">{Number(row.consecutive_limit_ups || 0) || '—'}</td></tr>)}</tbody></table>{snapshot.isLoading && <p className="p-8 text-center text-muted">正在读取全市场股票明细…</p>}{!snapshot.isLoading && !metricRows.length && <p className="p-8 text-center text-muted">该分类暂无股票</p>}</div>
        {visibleCount < metricRows.length && <button type="button" onClick={() => setVisibleCount(count => count + 300)} className="mt-2 rounded border border-border py-1 text-xs text-accent">继续显示（剩余 {metricRows.length - visibleCount} 只）</button>}
      </div></div>}
      <KpiCell onClick={() => openMetric(0)} label="个股涨 / 平 / 跌" value={<><span className="text-bull">{data.breadth.up}</span><span className="text-muted">/</span><span className="text-muted">{data.breadth.flat}</span><span className="text-muted">/</span><span className="text-bear">{data.breadth.down}</span></>} sub={`上涨率 ${data.breadth.up_pct.toFixed(1)}% · 点击看股票`} />
      <KpiCell onClick={() => openMetric(1)} label="强势 / 弱势" value={<><span className="text-bull">{strongUp}</span><span className="text-muted">/</span><span className="text-bear">{strongDown}</span></>} sub="涨跌 ≥3% · 点击看股票" />
      <KpiCell onClick={() => openMetric(2)} label={<span className="inline-flex items-center gap-1">涨停 / 跌停<SealedBadge degraded={isSealedDegrade} hasDepth={hasDepth} isHistorical={false} sealedReady={sealedReady} sealedCountsUp={{ real: data.limit.limit_up, fake: data.limit.fake_up ?? 0, pending: 0 }} sealedCountsDown={{ real: data.limit.limit_down, fake: data.limit.fake_down ?? 0, pending: 0 }} rawUp={data.limit.limit_up + (data.limit.fake_up ?? 0)} rawDown={data.limit.limit_down + (data.limit.fake_down ?? 0)} invalidateKeys={['overview-market', 'limit-ladder']} /></span>} value={<><span className="text-bull">{data.limit.limit_up}</span><span className="text-muted">/</span><span className="text-bear">{data.limit.limit_down}</span></>} sub={`封板率 ${(data.limit.seal_rate ?? 0).toFixed(0)}% · 点击看股票`} />
      <KpiCell onClick={() => openMetric(3)} label="最高连板" value={`${data.limit.max_boards || 0}板`} sub={(() => {
        const top = data.limit.tiers.find(t => t.boards === data.limit.max_boards)
        const stocks = top?.stocks ?? []
        if (stocks.length > 0 && stocks.length <= 3) return stocks.map(s => s.name || s.symbol).join(' · ')
        return `梯队 ${data.limit.tiers.length}`
      })()} tone="accent" />
      <KpiCell onClick={() => openMetric(4)} label="成交额" value={fmtBigNum(data.amount.total)} sub={`均额 ${fmtBigNum(data.amount.avg)} · 点击看排行`} />
      <KpiCell onClick={() => openMetric(5)} label="换手 / 量比" value={`${fmtPrice(data.activity.avg_turnover, 1)}% / ${fmtPrice(data.activity.vol_ratio, 2)}`} sub={`高换手 ${data.activity.high_turnover} · 点击看股票`} tone="accent" />
    </div>
  )
}

function TrendWidget({ ctx }: { ctx: WidgetCtx }) {
  const { data } = ctx
  return (
    <div className="flex h-full flex-col">
      <div>
        <SectionTitle icon={LineChart} title="趋势强度" hint="均线/新高低" />
        <div className="grid grid-cols-3 gap-1.5">
          <MiniMetric label="站上MA5" value={`${data.trend.above_ma5_pct.toFixed(0)}%`} cls="text-accent" />
          <MiniMetric label="站上MA20" value={`${data.trend.above_ma20_pct.toFixed(0)}%`} cls="text-accent" />
          <MiniMetric label="站上MA60" value={`${data.trend.above_ma60_pct.toFixed(0)}%`} cls="text-accent" />
          <MiniMetric label="60日新高" value={`${compactCount(data.trend.new_high)}`} cls="text-bull" />
          <MiniMetric label="60日新低" value={`${compactCount(data.trend.new_low)}`} cls="text-bear" />
          <MiniMetric label="高低比" value={`${data.trend.new_high + data.trend.new_low > 0 ? Math.round(data.trend.new_high / (data.trend.new_high + data.trend.new_low) * 100) : 50}%`} cls={data.trend.new_high >= data.trend.new_low ? 'text-bull' : 'text-bear'} />
        </div>
      </div>
      <div className="mt-1.5 border-t border-border pt-1.5">
        <SectionTitle icon={Target} title="实用监控" hint="盘中观察" />
        <div className="grid grid-cols-3 gap-1.5">
          <MiniMetric label="炸板" value={`${data.limit.broken ?? 0}`} cls="text-warning" />
          <MiniMetric label="跌停" value={`${data.limit.limit_down ?? 0}`} cls="text-bear" />
          <MiniMetric label="站上MA60" value={`${data.trend.above_ma60_pct.toFixed(0)}%`} cls="text-accent" />
          <MiniMetric label="新高/新低" value={`${compactCount(data.trend.new_high)}/${compactCount(data.trend.new_low)}`} cls={data.trend.new_high >= data.trend.new_low ? 'text-bull' : 'text-bear'} />
          <MiniMetric label="高换手数" value={`${data.activity.high_turnover}`} cls="text-accent" />
          <MiniMetric label="放量占比" value={`${fmtPrice(data.activity.high_vol_ratio, 1)}%`} cls="text-accent" />
        </div>
      </div>
    </div>
  )
}

function MonitorSection({ ctx }: { ctx: WidgetCtx }) {
  return (
    <section className="h-full overflow-hidden rounded-card border border-border bg-surface/80 p-1.5 shadow-[0_1px_2px_hsl(var(--border)/0.4)] backdrop-blur-sm transition-shadow hover:shadow-[0_2px_8px_hsl(var(--border)/0.5)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <BellRing className="h-3.5 w-3.5 text-accent" />
          <h2 className="text-xs font-semibold text-foreground">监控中心</h2>
          <span className="font-mono text-[10px] text-muted">实时信号</span>
        </div>
        <Link to="/monitor" className="inline-flex items-center justify-center h-5 w-5 rounded text-muted hover:text-accent hover:bg-accent/10 transition-colors" title="进入监控中心">
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="max-h-full overflow-y-auto">
        <MonitorWidget
          activeSymbol={ctx.activeSymbol('alert')}
          onStockClick={ctx.openAlert}
        />
      </div>
    </section>
  )
}

/** 外链渲染见 ExternalLinkWidget (registry ext-link 项) */

export const WIDGET_DEFS: WidgetDef[] = [
  {
    id: 'indices', label: '指数行情', icon: Gauge, minW: 4, minH: 2, defW: 12, defH: 2,
    render: ctx => <IndexTickerList fallback={ctx.data.indices} />,
  },
  {
    id: 'kpi', label: '大盘指标', icon: BarChart3, minW: 6, minH: 2, defW: 12, defH: 2,
    render: ctx => <KpiWidget ctx={ctx} />,
  },
  {
    id: 'market-overview', label: '大盘走势与量能', icon: LineChart, minW: 8, minH: 30, defW: 12, defH: 30,
    render: ctx => <MarketOverviewWidget data={ctx.data} tradeDate={ctx.data.as_of ?? undefined} />,
  },
  {
    id: 'distribution', label: '涨跌分布 / 广度', icon: BarChart3, minW: 3, minH: 6, defW: 4, defH: 8,
    render: ctx => sectionCard(
      <>
        <SectionTitle icon={BarChart3} title="涨跌分布 / 广度" hint={`${ctx.data.breadth.total}只`} />
        <DistributionBars rows={ctx.data.distribution} />
        <div className="mt-2">
          <BreadthBar data={ctx.data.breadth} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <MiniMetric label="平均涨跌" value={fmtStockPct(ctx.data.breadth.avg_pct)} cls={pctClass(ctx.data.breadth.avg_pct)} />
          <MiniMetric label="中位涨跌" value={fmtStockPct(ctx.data.breadth.median_pct)} cls={pctClass(ctx.data.breadth.median_pct)} />
        </div>
      </>,
    ),
  },
  {
    id: 'radar', label: '情绪雷达', icon: Sparkles, minW: 3, minH: 7, defW: 4, defH: 8,
    render: ctx => <EmotionRadarCard ctx={ctx} />,
  },
  {
    id: 'trend', label: '趋势强度 / 实用监控', icon: LineChart, minW: 3, minH: 6, defW: 4, defH: 8,
    render: ctx => sectionCard(<TrendWidget ctx={ctx} />),
  },
  {
    id: 'concept-rank', label: '概念热度', icon: Flame, minW: 3, minH: 6, defW: 6, defH: 8,
    render: ctx => (
      <HotRankCard title="概念热度" rank={ctx.data.concept_rank} configUrl="/concept-analysis"
        activeSymbol={ctx.activeSymbol('concept')}
        onStockClick={(symbol, name) => ctx.openStock('concept', symbol, name, rankNav(ctx.data.concept_rank))}
        onDimensionClick={ctx.openDimension} />
    ),
  },
  {
    id: 'industry-rank', label: '行业热度', icon: Flame, minW: 3, minH: 6, defW: 6, defH: 8,
    render: ctx => (
      <HotRankCard title="行业热度" rank={ctx.data.industry_rank} configUrl="/industry-analysis"
        activeSymbol={ctx.activeSymbol('industry')}
        onStockClick={(symbol, name) => ctx.openStock('industry', symbol, name, rankNav(ctx.data.industry_rank))}
        onDimensionClick={ctx.openDimension} />
    ),
  },
  {
    id: 'gainers', label: '涨幅榜', icon: TrendingUp, minW: 2, minH: 7, defW: 3, defH: 10,
    render: ctx => (
      <StockList title="涨幅榜" rows={ctx.data.top_gainers} mode="gain"
        activeSymbol={ctx.activeSymbol('gain')}
        onStockClick={(symbol, name) => ctx.openStock('gain', symbol, name, stockListNav(ctx.data.top_gainers))} />
    ),
  },
  {
    id: 'losers', label: '跌幅榜', icon: TrendingDown, minW: 2, minH: 7, defW: 3, defH: 10,
    render: ctx => (
      <StockList title="跌幅榜" rows={ctx.data.top_losers} mode="loss"
        activeSymbol={ctx.activeSymbol('loss')}
        onStockClick={(symbol, name) => ctx.openStock('loss', symbol, name, stockListNav(ctx.data.top_losers))} />
    ),
  },
  {
    id: 'turnover', label: '成交额榜', icon: Coins, minW: 2, minH: 7, defW: 3, defH: 10,
    render: ctx => (
      <StockList title="成交额榜" rows={ctx.data.turnover_leaders} mode="amount"
        activeSymbol={ctx.activeSymbol('amount')}
        onStockClick={(symbol, name) => ctx.openStock('amount', symbol, name, stockListNav(ctx.data.turnover_leaders))} />
    ),
  },
  {
    id: 'activity', label: '活跃换手', icon: Repeat, minW: 2, minH: 7, defW: 3, defH: 10,
    render: ctx => (
      <StockList title="活跃换手" rows={ctx.data.active_leaders} mode="active"
        activeSymbol={ctx.activeSymbol('active')}
        onStockClick={(symbol, name) => ctx.openStock('active', symbol, name, stockListNav(ctx.data.active_leaders))} />
    ),
  },
  {
    id: 'ladder', label: '涨停梯队', icon: Flame, minW: 3, minH: 6, defW: 4, defH: 8,
    render: ctx => sectionCard(
      <>
        <SectionTitle icon={Flame} title="涨停梯队" hint={<span className="inline-flex items-center gap-1">{`涨停 ${ctx.data.limit.limit_up}`}{ctx.isSealedDegrade && <span className="text-[9px] px-1 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-500">{ctx.hasDepth ? '未修正' : '降级'}</span>}</span>} />
        <LadderMini limit={ctx.data.limit} />
      </>,
    ),
  },
  {
    id: 'monitor', label: '监控中心', icon: BellRing, minW: 2, minH: 6, defW: 4, defH: 10,
    render: ctx => <MonitorSection ctx={ctx} />,
  },
  {
    id: 'fund-flow', label: '资金流向', icon: LineChart, minW: 6, minH: 9, defW: 6, defH: 13,
    render: () => <FundFlowPanel compact />,
  },
  {
    id: 'holdings', label: '持仓涨跌', icon: BarChart3, minW: 4, minH: 8, defW: 6, defH: 12,
    render: () => <HoldingsWidget />,
  },
  {
    id: 'portfolio-monitor', label: '持仓·分时·板块·新闻', icon: LineChart, minW: 6, minH: 12, defW: 12, defH: 22,
    render: () => <PortfolioMonitorWidget />,
  },
  {
    id: 'sector-watch', label: '关联板块异动', icon: BellRing, minW: 4, minH: 8, defW: 6, defH: 12,
    render: () => <SectorWatchWidget />,
  },
  {
    id: 'market-news', label: '市场新闻', icon: BellRing, minW: 4, minH: 8, defW: 6, defH: 12,
    render: () => <MarketNewsWidget />,
  },
  {
    id: 'page-panel', label: '已有页面', icon: Link2, minW: 4, minH: 8, defW: 12, defH: 18,
    render: (_ctx, item) => <PageWidget path={item.p?.path ?? ''} />,
  },
  {
    id: 'ext-link', label: '外部链接', icon: Link2, minW: 2, minH: 5, defW: 6, defH: 10,
    render: (_ctx, item) => <ExternalLinkWidget title={item.p?.title ?? '外部链接'} url={item.p?.url ?? 'about:blank'} />,
  },
]

const _DEF_INDEX = new Map(WIDGET_DEFS.map(d => [d.id, d]))

export function widgetDef(id: WidgetType): WidgetDef | undefined {
  return _DEF_INDEX.get(id)
}

export function isKnownWidgetType(t: string): boolean {
  return _DEF_INDEX.has(t as WidgetType)
}

export function minSizeOf(t: WidgetType): { w: number; h: number } {
  const d = _DEF_INDEX.get(t)
  return { w: d?.minW ?? 2, h: d?.minH ?? 4 }
}

/** 默认布局 — 首屏优先呈现指数/KPI、大盘实时曲线与量能、持仓综合监控；
 * 下方再放市场宽度、板块、资金流和新闻。这样首次打开就能进入“看盘”状态，
 * 其余窗口仍可通过自定义布局或右键添加。
 * 坐标必须是竖直压实后的稳定形态(列内不留空隙), 否则 RGL 渲染时会自动上提,
 * 导致「恢复默认」的 JSON 等值判断永不成立、每次都落 blob 而非 null。 */
/** 简洁看盘：首屏只保留市场、量能和持仓核心窗口。 */
export const DEFAULT_LAYOUT: DashboardItem[] = [
  { i: 'indices', t: 'indices', x: 0, y: 0, w: 12, h: 2 },
  { i: 'kpi', t: 'kpi', x: 0, y: 2, w: 12, h: 2 },
  { i: 'market-overview', t: 'market-overview', x: 0, y: 4, w: 12, h: 30 },
  { i: 'portfolio-monitor', t: 'portfolio-monitor', x: 0, y: 34, w: 12, h: 24 },
]

/** 功能版本：所有内置看板窗口，便于用户按需删减和重新布局。 */
export const FEATURE_LAYOUT: DashboardItem[] = [
  ...WIDGET_DEFS.filter(def => !['page-panel', 'ext-link'].includes(def.id)).map((def, index) => ({
    i: def.id,
    t: def.id,
    x: (index % 3) * 4,
    y: Math.floor(index / 3) * 9,
    w: 4,
    h: Math.max(8, def.defH),
  })),
]

/* 旧版完整默认布局保留在版本迁移之外；用户可通过“功能版本”恢复全部窗口。 */
/*
  { i: 'distribution', t: 'distribution', x: 0, y: 44, w: 3, h: 8 },
  { i: 'radar', t: 'radar', x: 3, y: 44, w: 3, h: 8 },
  { i: 'trend', t: 'trend', x: 6, y: 44, w: 3, h: 8 },
  { i: 'ladder', t: 'ladder', x: 9, y: 44, w: 3, h: 8 },
  { i: 'concept-rank', t: 'concept-rank', x: 0, y: 52, w: 4, h: 9 },
  { i: 'industry-rank', t: 'industry-rank', x: 4, y: 52, w: 4, h: 9 },
  { i: 'sector-watch', t: 'sector-watch', x: 8, y: 52, w: 4, h: 13 },
  { i: 'gainers', t: 'gainers', x: 0, y: 61, w: 2, h: 13 },
  { i: 'losers', t: 'losers', x: 2, y: 61, w: 2, h: 13 },
  { i: 'turnover', t: 'turnover', x: 4, y: 61, w: 2, h: 13 },
  { i: 'activity', t: 'activity', x: 6, y: 61, w: 2, h: 13 },
  { i: 'monitor', t: 'monitor', x: 8, y: 65, w: 4, h: 18 },
  { i: 'market-news', t: 'market-news', x: 0, y: 74, w: 6, h: 12 },
  { i: 'fund-flow', t: 'fund-flow', x: 0, y: 86, w: 6, h: 13 },
  { i: 'holdings', t: 'holdings', x: 6, y: 86, w: 6, h: 13 },
*/
