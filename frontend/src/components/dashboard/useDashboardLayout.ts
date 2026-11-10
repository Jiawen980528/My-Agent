/**
 * 看板布局持久化 hook — 后端偏好加载 + 本地改动防抖落盘。
 *
 * 返回 { items, setItems }:
 * - items: 本地有改动取本地, 否则取后端保存布局(规范化), 再退内置默认。
 * - setItems: 本地改动入口; 800ms 防抖保存到 PUT /preferences/dashboard-layout,
 *   与内置默认布局完全一致时存 null(清除), 让代码内置默认可随版本演进。
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { usePreferences } from '@/lib/useSharedQueries'
import { DEFAULT_LAYOUT } from './registry'
import { normalizeDashboardLayout } from './DashboardGrid'
import { cloneItems, compactLayout, toBlob, type DashboardItem } from './layout'

const SAVE_DEBOUNCE_MS = 800

export function useDashboardLayout(): {
  items: DashboardItem[]
  setItems: (next: DashboardItem[]) => void
  saveError: string | null
  retrySave: () => void
} {
  const { data: prefs } = usePreferences()
  const saved = useMemo(() => {
    // 首次切换到持仓工作区时强制套用一次新布局，避免旧的全宽布局偏好覆盖页面升级。
    if (typeof window !== 'undefined' && !window.localStorage.getItem('dashboard-layout-holdings-v8')) {
      window.localStorage.setItem('dashboard-layout-holdings-v8', '1')
      return cloneItems(DEFAULT_LAYOUT)
    }
    const normalized = normalizeDashboardLayout(prefs?.dashboard_layout ?? undefined)
    const types = new Set(normalized.map(item => item.t))
    // 将上一版默认的“指数/KPI/大盘/持仓”布局迁移为持仓中心布局；
    // 用户已经添加其他窗口时保留其自定义布局。
    if ((types.size === 4 && types.has('indices') && types.has('kpi') && types.has('market-overview') && types.has('portfolio-monitor'))
      || (types.size === 4 && types.has('market-overview') && types.has('portfolio-monitor') && types.has('fund-flow') && types.has('market-news'))
      || (types.size === 5 && types.has('market-overview') && types.has('portfolio-monitor') && types.has('kpi') && types.has('fund-flow') && types.has('market-news'))) {
      return cloneItems(DEFAULT_LAYOUT)
    }
    // 版本升级迁移：旧布局可能只有指数/KPI，导致新版看盘能力一直藏在“添加窗口”里。
    // 只补缺失的核心窗口，不覆盖用户已保存的坐标、尺寸和其他自定义窗口。
    const next = [...normalized]
    if (!next.some(item => item.t === 'market-overview')) {
      next.push({ i: 'market-overview', t: 'market-overview', x: 0, y: 0, w: 12, h: 18 })
    }
    if (!next.some(item => item.t === 'portfolio-monitor')) {
      next.push({ i: 'portfolio-monitor', t: 'portfolio-monitor', x: 0, y: 0, w: 12, h: 24 })
    }
    return compactLayout(next)
  }, [prefs?.dashboard_layout])
  const [local, setLocal] = useState<DashboardItem[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (local === null) return
    const blob = toBlob(local)
    const isDefault = JSON.stringify(blob.items) === JSON.stringify(DEFAULT_LAYOUT)
    const timer = window.setTimeout(() => {
      api.saveDashboardLayout(isDefault ? null : blob)
        .then(() => setSaveError(null))
        .catch(error => setSaveError(error instanceof Error ? error.message : '布局保存失败'))
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [local, retry])

  return { items: local ?? saved, setItems: setLocal, saveError, retrySave: () => setRetry(value => value + 1) }
}
