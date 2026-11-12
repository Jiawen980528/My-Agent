import { lazy, Suspense, useEffect } from 'react'
import { createBrowserRouter, Navigate, useRouteError, useSearchParams } from 'react-router-dom'
import { Layout } from './components/Layout'
import { useSettings } from './lib/useSharedQueries'
import { Logo } from './components/Logo'
import { ExtensionBoundary } from './extensions/ExtensionBoundary'
import {
  finalizeFrontendExtensions,
  getFrontendExtensionLoadErrors,
  getFrontendExtensionRoutes,
} from './extensions/registry'

// 代码分割: 页面全部 lazy 加载, 避免首屏打包所有页面 (ECharts / lightweight-charts /
// framer-motion 等重库) → 大幅减小首屏 bundle。命名导出用 .then 映射为 default。
// Layout / Onboarding / Auth 为应用外壳与入口, 保持同步加载。
const Watchlist = lazy(() => import('./pages/Watchlist').then(m => ({ default: m.Watchlist })))
const Screener = lazy(() => import('./pages/Screener').then(m => ({ default: m.Screener })))
const Backtest = lazy(() => import('./pages/Backtest').then(m => ({ default: m.Backtest })))
const Factors = lazy(() => import('./pages/Factors').then(m => ({ default: m.Factors })))
const Data = lazy(() => import('./pages/Data').then(m => ({ default: m.Data })))
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })))
const PickModel = lazy(() => import('./pages/PickModel').then(m => ({ default: m.PickModel })))
const SentimentMonitor = lazy(() => import('./pages/SentimentMonitor').then(m => ({ default: m.SentimentMonitor })))
const RecommendationPage = lazy(() => import('./pages/RecommendationPage').then(m => ({ default: m.RecommendationPage })))
const StrongSectors = lazy(() => import('./pages/PickModel').then(m => ({ default: m.PickModel })))
const MyAgentQuant = lazy(() => import('./pages/MyAgentQuant').then(m => ({ default: m.MyAgentQuant })))
const FundFlow = lazy(() => import('./pages/FundFlow').then(m => ({ default: m.FundFlow })))
const MarketNews = lazy(() => import('./pages/MarketNews').then(m => ({ default: m.MarketNews })))
const DecisionGuide = lazy(() => import('./pages/DecisionGuide').then(m => ({ default: m.DecisionGuide })))
const AnalysisDetail = lazy(() => import('./pages/AnalysisDetail').then(m => ({ default: m.AnalysisDetail })))
const Indices = lazy(() => import('./pages/Indices').then(m => ({ default: m.Indices })))
const Branding = lazy(() => import('./pages/Branding').then(m => ({ default: m.Branding })))
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })))
const Regime = lazy(() => import('./pages/Regime').then(m => ({ default: m.Regime })))
const Dev = lazy(() => import('./pages/Dev').then(m => ({ default: m.Dev })))
// Onboarding 只在首次使用时进入, Auth 只在登录页用到 — 均改按需加载
const Onboarding = lazy(() => import('./pages/Onboarding').then(m => ({ default: m.Onboarding })))
const Auth = lazy(() => import('./pages/Auth').then(m => ({ default: m.Auth })))

const CORE_ROUTE_PATHS = new Set([
  '/',
  '/onboarding',
  '/login',
  '/overview',
  '/analysis',
  '/analysis/:menuId',
  '/watchlist',
  '/screener',
  '/backtest',
  '/factors',
  '/mining',
  '/data',
  '/indices',
  '/regime',
  '/branding',
  '/settings',
  '/dev',
  '/settings/keys',
  '/settings/ai',
  '/settings/queries',
  '/pick-model',
  '/sentiment-monitor',
  '/recommendations',
  '/strong-sectors',
  '/myagent-quant',
  '/holdings',
  '/fund-flow',
  '/market-news',
  '/decision-guide',
])

finalizeFrontendExtensions(CORE_ROUTE_PATHS)
const frontendExtensionRoutes = getFrontendExtensionRoutes()
const frontendExtensionErrors = getFrontendExtensionLoadErrors()
if (frontendExtensionErrors.length > 0) {
  console.error('部分前端扩展加载失败', frontendExtensionErrors)
}

// 旧链接兼容: 挖掘已并入因子页 (/factors?tab=mining), 保留 run/candidate 等参数重定向
function MiningRedirect() {
  const [searchParams] = useSearchParams()
  const search = searchParams.toString()
  return <Navigate to={`/factors?tab=mining${search ? `&${search}` : ''}`} replace />
}

// 首次使用守卫 —— 未完成向导则重定向到 /onboarding
// 只挂在根路由上;/onboarding 本身不被守卫,避免循环重定向。
// settings 由 Layout 预取,守卫判定不产生额外请求。
function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const settings = useSettings()

  // 仅首次加载(本地无缓存)时显示占位。
  // 后台重取 (isFetching) 时本地已有上一份缓存可用, 直接放行, 避免切页时整屏 logo 闪烁。
  // 防误重定向已由 Onboarding/AI 等处 invalidate 前的 setQueryData 同步缓存兜底。
  if (settings.isLoading) {
    return (
      <div className="min-h-full bg-base grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Logo size={28} className="text-foreground" />
          <div className="text-xs">加载中…</div>
        </div>
      </div>
    )
  }

  // 查询出错或字段缺失时不拦截 —— 宁可放行,也不把用户卡在空白页
  if (settings.data && settings.data.onboarding_completed === false) {
    return <Navigate to="/onboarding" replace />
  }

  return <>{children}</>
}

// 按需路由的加载占位 (与 OnboardingGuard 的加载态同风格)
function RouteFallback() {
  return (
    <div className="min-h-full bg-base grid place-items-center">
      <Logo size={28} className="text-foreground" />
    </div>
  )
}

function RouteErrorFallback() {
  const error = useRouteError()
  const message = error instanceof Error ? error.message : String(error)
  useEffect(() => {
    if (!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)) return
    const key = 'tf-last-chunk-reload'
    let last = 0
    try { last = Number(sessionStorage.getItem(key) || 0) } catch { /* 存储不可用时仍显示手动重载 */ }
    if (Date.now() - last < 30_000) return
    try { sessionStorage.setItem(key, String(Date.now())) } catch { /* 存储不可用时仍可刷新 */ }
    window.location.reload()
  }, [message])
  return <div className="min-h-screen bg-base p-6 text-foreground">
    <div className="mx-auto max-w-lg rounded-card border border-border bg-surface p-5">
      <h1 className="text-base font-semibold">页面加载失败</h1>
      <p className="mt-2 text-xs text-muted">页面更新或网络中断后，旧页面可能无法加载新模块。</p>
      <p className="mt-2 break-all text-xs text-danger">{message}</p>
      <button onClick={() => window.location.reload()} className="mt-4 rounded-btn bg-accent px-3 py-2 text-xs text-white">重新加载页面</button>
    </div>
  </div>
}

export const router = createBrowserRouter([
  {
    path: '/onboarding',
    element: (
      <Suspense fallback={<RouteFallback />}>
        <Onboarding />
      </Suspense>
    ),
  },
  {
    path: '/login',
    element: (
      <Suspense fallback={<RouteFallback />}>
        <Auth />
      </Suspense>
    ),
  },
  {
    path: '/',
    errorElement: <RouteErrorFallback />,
    element: (
      <OnboardingGuard>
        <Layout />
      </OnboardingGuard>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'pick-model', element: <PickModel /> },
      { path: 'sentiment-monitor', element: <SentimentMonitor /> },
      { path: 'recommendations', element: <RecommendationPage /> },
      { path: 'strong-sectors', element: <StrongSectors /> },
      { path: 'myagent-quant', element: <MyAgentQuant /> },
      { path: 'holdings', element: <MyAgentQuant /> },
      { path: 'fund-flow', element: <FundFlow /> },
      { path: 'overview', element: <Navigate to="/" replace /> },
      { path: 'analysis', element: <Navigate to="/settings?tab=pages&section=ext-pages" replace /> },
      { path: 'analysis/:menuId', element: <AnalysisDetail /> },
      { path: 'watchlist', element: <Watchlist /> },
      { path: 'screener', element: <Screener /> },
      { path: 'backtest', element: <Backtest /> },
      { path: 'factors', element: <Factors /> },
      { path: 'mining', element: <MiningRedirect /> },
      { path: 'data', element: <Data /> },
      { path: 'indices', element: <Indices /> },
      { path: 'market-news', element: <MarketNews /> },
      { path: 'decision-guide', element: <DecisionGuide /> },
    { path: 'regime', element: <Regime /> },
      { path: 'branding', element: <Branding /> },
      { path: 'settings', element: <Settings /> },
      // 隐藏路由：开发者工具（不暴露在菜单，仅供调试）
      { path: 'dev', element: <Dev /> },
      // 旧路由兼容重定向
      { path: 'settings/keys', element: <Navigate to="/settings?tab=data-sources" replace /> },
      { path: 'settings/ai', element: <Navigate to="/settings?tab=ai" replace /> },
      { path: 'settings/queries', element: <Navigate to="/settings?tab=queries" replace /> },
      ...frontendExtensionRoutes.map(route => {
        const ExtensionPage = route.component
        return {
          path: route.path.slice(1),
          element: (
            <ExtensionBoundary extensionId={route.extensionId}>
              <ExtensionPage />
            </ExtensionBoundary>
          ),
        }
      }),
    ],
  },
], { basename: '/quant' })
