import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryCache } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { initializeFrontendExtensions } from './extensions/bootstrap'
import { installTspExtBridge, loadRuntimePageExtensions } from './extensions/runtime'
import { stockPreviewUi } from './lib/stockPreviewStore'
import { api, ApiError } from './lib/api'
import { retryDelay } from './lib/refreshPolicy'
import { QK } from './lib/queryKeys'
import { cn } from './lib/cn'
import * as format from './lib/format'
import { createAppPersister, shouldPersistQuery, PERSIST_BUSTER } from './lib/queryPersist'
import { hydrateUiPrefs } from './lib/uiPrefs'
import { applyPageZoom, getPageZoom } from './lib/pageZoom'
import { applyTheme, getTheme } from './lib/theme'
import { applyFontScale, getFontScale } from './lib/fontScale'
// 字体自托管 (@fontsource): 替代 rsms.me / Google Fonts 渲染阻塞外链,
// 内网/离线部署不再白屏等字体。权重覆盖 tailwind 全部用量 (300-900)。
import '@fontsource/inter/300.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/900.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './index.css'

// 部署新版本后，已打开的旧页面可能继续引用被替换的哈希模块。
// Vite 在动态模块加载失败时发出此事件；自动刷新一次以取得新入口与新模块名。
window.addEventListener('vite:preloadError', (event) => {
  const key = 'tf-last-chunk-reload'
  let last = 0
  try { last = Number(sessionStorage.getItem(key) || 0) } catch { /* 私密模式仍允许刷新 */ }
  if (Date.now() - last < 30_000) return
  event.preventDefault()
  try { sessionStorage.setItem(key, String(Date.now())) } catch { /* 浏览器禁用存储 */ }
  window.location.reload()
})

// 全局认证拦截: 任何 query/mutation 收到 401 (未登录/会话过期) → 跳登录页。
// api.ts 的 request() 已对 401 静默 (不弹 toast), 这里统一负责跳转。
// 排除 /login 自身的请求, 避免登录页请求失败又跳登录形成死循环。
const _redirectToLogin = (() => {
  let redirecting = false
  return (err: unknown) => {
    if (redirecting) return
    if (!(err instanceof Error)) return
    const msg = err.message || ''
    // 401 (未登录/会话过期) → 跳登录页
    // 403 未初始化 (面板未设密码, 公网访问) → 也跳登录页(显示设密码提示)
    const is401 = msg.includes('未登录') || msg.includes('会话已过期') || msg.includes('401')
    const isNotInit = msg.includes('尚未初始化访问密码') || msg.includes('NOT_INITIALIZED')
    if (!is401 && !isNotInit) return
    // 已在登录页则不跳(避免死循环)
    if (window.location.pathname === '/quant/login') return
    redirecting = true
    // RouterProvider already owns the /quant basename. Store only the
    // application-relative path, otherwise login returns to /quant/quant/.
    const appPath = window.location.pathname.startsWith('/quant')
      ? (window.location.pathname.slice('/quant'.length) || '/')
      : window.location.pathname
    const redirect = encodeURIComponent(appPath + window.location.search)
    window.location.href = `/quant/login?redirect=${redirect}`
  }
})()

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => _redirectToLogin(err),
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,           // 5s 内复用,与 §4.2 Repository 不变量一致
      refetchOnWindowFocus: false,
      retryDelay: (attempt, error) => retryDelay(attempt, error instanceof ApiError ? error.retryAfterMs : undefined),
    },
    mutations: {
      onError: (err) => _redirectToLogin(err),
    },
  },
})

async function bootstrap() {
  // 界面偏好回填: 桌面版启动端口从 3018 起递增, 端口一变 origin 就变, 只存
  // localStorage 的设置 (通知/声效/语音/外链模板/缩放) 会读不到。后端保存权威
  // 副本，回填后重放主题、页面缩放和字体缩放；首帧仍由内联脚本应用缓存。
  // 不 await: 网络慢时不能拖住首屏。
  void hydrateUiPrefs().then(() => {
    applyPageZoom(getPageZoom())
    applyTheme(getTheme())
    applyFontScale(getFontScale())
  })
  await initializeFrontendExtensions()
  // 页面插件能力桥: 共享 api/QK/cn/format 和宿主 UI 操作，不复制弹窗状态。
  installTspExtBridge({ api, QK, cn, format, ui: stockPreviewUi })
  // 运行时页面插件: 必须在 router 模块求值(finalize + 建路由表)之前挂载
  await loadRuntimePageExtensions()
  const { router } = await import('./router')
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: createAppPersister(),
          buster: PERSIST_BUSTER,
          // 恢复超过 1 天的缓存直接丢弃 (慢变族一天内必然后台刷新过)
          maxAge: 24 * 60 * 60 * 1000,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <RouterProvider router={router} />
      </PersistQueryClientProvider>
    </React.StrictMode>,
  )
}

void bootstrap()
