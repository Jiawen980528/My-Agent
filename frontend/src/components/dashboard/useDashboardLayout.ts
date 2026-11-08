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
import { compactLayout, toBlob, type DashboardItem } from './layout'

const SAVE_DEBOUNCE_MS = 800

export function useDashboardLayout(): {
  items: DashboardItem[]
  setItems: (next: DashboardItem[]) => void
  saveError: string | null
  retrySave: () => void
} {
  const { data: prefs } = usePreferences()
  const saved = useMemo(() => {
    const normalized = normalizeDashboardLayout(prefs?.dashboard_layout ?? undefined)
    // 版本升级迁移：旧布局没有大盘走势主窗口时，把它放到指数/KPI之后。
    // 只补缺失组件，不覆盖用户已有的布局顺序和尺寸。
    if (normalized.some(item => item.t === 'market-overview')) return normalized
    const next: DashboardItem[] = [...normalized, { i: 'market-overview', t: 'market-overview', x: 0, y: 4, w: 12, h: 20 }]
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
