import { describe, expect, it } from 'vitest'
import { resolveBoardSearchOption } from './PortfolioMonitorWidget'

describe('resolveBoardSearchOption', () => {
  const local = [{ code: 'BK0001', name: '本地板块' }]

  it('applies a remote name result even when it is absent from local options', () => {
    expect(resolveBoardSearchOption('半导体设备材料', [
      { code: 'BK1325', name: '半导体材料' },
      { code: 'BK1326', name: '半导体设备' },
    ], local)).toEqual({ code: 'BK1326', name: '半导体设备' })
  })

  it('normalizes a six-digit Tonghuashun index code', () => {
    expect(resolveBoardSearchOption('931743', [{ code: '931743.TI', name: '半导体设备材料' }], [])?.code).toBe('931743.TI')
  })

  it('still matches local board names and codes', () => {
    expect(resolveBoardSearchOption('BK0001', [], local)?.name).toBe('本地板块')
  })
})
