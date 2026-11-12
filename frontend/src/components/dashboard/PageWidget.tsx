import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { getFrontendExtensionNavigation } from '@/extensions/registry'

type PageOption = { path: string; label: string; component: ComponentType }

const CORE_PAGES: PageOption[] = [
  { path: '/watchlist', label: '自选', component: lazy(() => import('@/pages/Watchlist').then(m => ({ default: m.Watchlist }))) },
  { path: '/screener', label: '策略筛选', component: lazy(() => import('@/pages/Screener').then(m => ({ default: m.Screener }))) },
  { path: '/factors', label: '因子与挖掘', component: lazy(() => import('@/pages/Factors').then(m => ({ default: m.Factors }))) },
  { path: '/backtest', label: '回测', component: lazy(() => import('@/pages/Backtest').then(m => ({ default: m.Backtest }))) },
  { path: '/indices', label: '指数', component: lazy(() => import('@/pages/Indices').then(m => ({ default: m.Indices }))) },
  { path: '/regime', label: '市场环境', component: lazy(() => import('@/pages/Regime').then(m => ({ default: m.Regime }))) },
  { path: '/data', label: '数据', component: lazy(() => import('@/pages/Data').then(m => ({ default: m.Data }))) },
  { path: '/pick-model', label: '拾贝模型', component: lazy(() => import('@/pages/PickModel').then(m => ({ default: m.PickModel }))) },
  { path: '/sentiment-monitor', label: '情绪监控', component: lazy(() => import('@/pages/SentimentMonitor').then(m => ({ default: m.SentimentMonitor }))) },
  { path: '/recommendations', label: '今日推荐', component: lazy(() => import('@/pages/RecommendationPage').then(m => ({ default: m.RecommendationPage }))) },
  { path: '/myagent-quant', label: 'MyAgent 量化', component: lazy(() => import('@/pages/MyAgentQuant').then(m => ({ default: m.MyAgentQuant }))) },
  { path: '/fund-flow', label: '资金流向完整页', component: lazy(() => import('@/pages/FundFlow').then(m => ({ default: m.FundFlow }))) },
  { path: '/market-news', label: '市场新闻', component: lazy(() => import('@/pages/MarketNews').then(m => ({ default: m.MarketNews }))) },
  { path: '/decision-guide', label: '行情推演', component: lazy(() => import('@/pages/DecisionGuide').then(m => ({ default: m.DecisionGuide }))) },
  { path: '/settings', label: '设置', component: lazy(() => import('@/pages/Settings').then(m => ({ default: m.Settings }))) },
  { path: '/branding', label: '界面品牌', component: lazy(() => import('@/pages/Branding').then(m => ({ default: m.Branding }))) },
]

export function pageWidgetOptions(): PageOption[] {
  // 路由模块冻结扩展注册表后才会加载 Dashboard；测试环境下仍可列出核心页。
  try {
    return [...CORE_PAGES, ...getFrontendExtensionNavigation().map(item => ({
      path: item.route.path, label: item.label, component: item.route.component,
    }))]
  } catch {
    return CORE_PAGES
  }
}

class PageBoundary extends Component<{ children: ReactNode; path: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous: { path: string }) {
    if (previous.path !== this.props.path && this.state.failed) this.setState({ failed: false })
  }
  render() {
    if (this.state.failed) return <p className="p-3 text-xs text-danger">页面模块加载失败。请刷新看板后重试。</p>
    return this.props.children
  }
}

export function PageWidget({ path }: { path: string }) {
  const option = pageWidgetOptions().find(item => item.path === path)
  if (!option) return <div className="h-full rounded-card border border-border bg-surface p-3 text-xs text-muted">此页面已移除。请在布局编辑中删除窗口。</div>
  const Page = option.component
  return <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface text-foreground">
    <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-xs font-semibold">
      <span>{option.label}</span><Link to={path} className="inline-flex items-center gap-1 text-accent">打开完整页面<ArrowUpRight className="h-3 w-3" /></Link>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <PageBoundary path={path}><Suspense fallback={<p className="p-3 text-xs text-muted">正在加载页面…</p>}><Page /></Suspense></PageBoundary>
    </div>
  </section>
}
