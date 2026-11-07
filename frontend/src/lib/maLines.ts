import { useEffect, useState } from 'react'
import { hydrateUiPrefs, setUiPref } from './uiPrefs'

export const MA_PERIODS = [5, 10, 20, 60] as const
const KEY = 'tf-ma-lines'
const EVENT = 'tf-ma-lines-changed'

export function readMALines(): number[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return [...MA_PERIODS]
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) return MA_PERIODS.filter(period => value.includes(period))
  } catch { /* ignore invalid local settings */ }
  return [...MA_PERIODS]
}

export function useMALines(): [number[], (next: number[]) => void] {
  const [lines, setLines] = useState(readMALines)
  useEffect(() => {
    const refresh = () => setLines(readMALines())
    window.addEventListener(EVENT, refresh)
    window.addEventListener('storage', refresh)
    void hydrateUiPrefs().then(refresh)
    return () => {
      window.removeEventListener(EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  const save = (next: number[]) => {
    setUiPref(KEY, JSON.stringify(MA_PERIODS.filter(period => next.includes(period))))
    window.dispatchEvent(new Event(EVENT))
  }
  return [lines, save]
}
