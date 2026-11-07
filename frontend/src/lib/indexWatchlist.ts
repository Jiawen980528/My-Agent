import { useCallback, useEffect, useState } from 'react'
import { hydrateUiPrefs, setUiPref } from './uiPrefs'

export interface SavedIndex { symbol: string; name: string }

export const DEFAULT_INDEXES: SavedIndex[] = [
  { symbol: '000001.SH', name: '上证指数' },
  { symbol: '399001.SZ', name: '深证成指' },
  { symbol: '399006.SZ', name: '创业板指' },
  { symbol: '000680.SH', name: '科创综指' },
]

const KEY = 'tf-index-symbols'
const EVENT = 'tf-index-symbols-changed'
const SYMBOL = /^\d{6}\.(SH|SZ|BJ)$/

function normalize(value: unknown): SavedIndex[] {
  if (!Array.isArray(value)) return DEFAULT_INDEXES
  const result: SavedIndex[] = []
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const symbol = String(row.symbol ?? '').trim().toUpperCase()
    if (!SYMBOL.test(symbol) || result.some(row => row.symbol === symbol)) continue
    result.push({ symbol, name: String(row.name ?? symbol).trim().slice(0, 40) || symbol })
  }
  return result
}

export function readIndexWatchlist(): SavedIndex[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? DEFAULT_INDEXES : normalize(JSON.parse(raw))
  } catch { return DEFAULT_INDEXES }
}

export function saveIndexWatchlist(items: SavedIndex[]): void {
  const normalized = normalize(items)
  setUiPref(KEY, JSON.stringify(normalized))
  window.dispatchEvent(new Event(EVENT))
}

export function useIndexWatchlist(): [SavedIndex[], (items: SavedIndex[]) => void] {
  const [items, setItems] = useState(readIndexWatchlist)
  useEffect(() => {
    const refresh = () => setItems(readIndexWatchlist())
    window.addEventListener(EVENT, refresh)
    window.addEventListener('storage', refresh)
    void hydrateUiPrefs().then(refresh)
    return () => {
      window.removeEventListener(EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  const save = useCallback((next: SavedIndex[]) => saveIndexWatchlist(next), [])
  return [items, save]
}
