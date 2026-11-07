import type { MinuteKlineRow } from './api'
import type { OHLC } from '@/components/EChartsCandlestick'

/** Aggregate one-minute rows into trading-session-aligned K-bars. */
export function resampleMinutes(rows: MinuteKlineRow[], period: number): OHLC[] {
  const result: OHLC[] = []
  let lastKey = ''
  for (const row of rows) {
    const time = String(row.datetime ?? '')
    const match = time.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/)
    if (!match) continue
    const hour = Number(match[2]); const minute = Number(match[3])
    const clock = hour * 60 + minute
    const sessionStart = clock >= 13 * 60 ? 13 * 60 : 9 * 60 + 30
    const bucket = Math.max(0, Math.floor((clock - sessionStart) / period))
    const bucketClock = sessionStart + bucket * period
    const key = `${match[1]} ${String(Math.floor(bucketClock / 60)).padStart(2, '0')}:${String(bucketClock % 60).padStart(2, '0')}`
    const close = Number(row.close)
    if (!Number.isFinite(close)) continue
    const open = Number(row.open ?? close) || close
    const high = Number(row.high) || close
    const low = Number(row.low) || close
    const volume = Number(row.volume) || 0
    if (key !== lastKey) {
      result.push({ date: key, open, high, low, close, volume })
      lastKey = key
    } else {
      const bar = result[result.length - 1]
      bar.high = Math.max(bar.high, high)
      bar.low = Math.min(bar.low, low)
      bar.close = close
      bar.volume = (bar.volume ?? 0) + volume
    }
  }
  return result
}
