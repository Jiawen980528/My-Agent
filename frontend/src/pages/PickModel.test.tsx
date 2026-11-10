// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { PickModel } from './PickModel'

const apiMock = vi.hoisted(() => ({
  overviewMarket: vi.fn(async () => ({ as_of: '2026-11-10T10:30:00', quote_status: { is_trading_hours: true } })),
  sectorRotation: vi.fn(async () => ({ status: 'no_data' })),
  paperAccounts: vi.fn(async () => ({ accounts: [{ id: 'default', name: '模拟账户', status: 'active' }] })),
  paperOrderCreate: vi.fn(async () => ({ order: { status: 'pending' } })),
  myagentResearchPool: vi.fn(async () => ({ items: [{ symbol: '000739.SZ', name: '普洛药业', theme: '创新药', segment: '原料药', role: '产业链', rationale: 'CDMO', source_date: '2026-11-02' }], sources: ['资料.xlsx'] })),
  myagentResearchPoolImport: vi.fn(async () => ({ count: 1, imported: 1, unresolved: 0, sources: ['资料.xlsx'] })),
}))
vi.mock('@/lib/api', () => ({ api: apiMock }))

let cleanup = async () => {}
afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('shows only pool-and-model intersections and submits a paper order only after confirmation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    let body: unknown = { items: [] }
    if (url.endsWith('/scan') && init?.method === 'POST') body = { items: [
      { symbol: '000739.SZ', name: '普洛药业', score: 80, latest_date: '2026-11-10' },
      { symbol: '600519.SH', name: '贵州茅台', score: 99, latest_date: '2026-11-10' },
    ], count: 2 }
    if (url.endsWith('/ai') && init?.method === 'POST') body = { reply: '继续观察，等待量价确认。' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const host = document.createElement('div')
  const root = createRoot(host)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cleanup = async () => { await act(async () => root.unmount()); queryClient.clear() }
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><PickModel /></QueryClientProvider></MemoryRouter>))
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes(label))!
  await act(async () => { button('扫描全市场').click() })
  const shortlist = host.querySelector('section')!
  expect(shortlist.querySelectorAll('article')).toHaveLength(1)
  expect(shortlist.textContent).toContain('普洛药业')
  expect(shortlist.textContent).not.toContain('贵州茅台')
  await act(async () => { button('物理AI').click() })
  expect(shortlist.querySelectorAll('article')).toHaveLength(0)
  await act(async () => { button('全部').click() })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(true)
  await act(async () => { button('AI量化复核').click() })
  await act(async () => { button('模拟买入…').click() })
  expect(apiMock.paperOrderCreate).not.toHaveBeenCalled()
  await act(async () => { button('确认模拟买入').click() })
  expect(apiMock.paperOrderCreate).toHaveBeenCalledWith(
    { symbol: '000739.SZ', side: 'buy', qty: 100, order_type: 'market' }, 'default',
  )
})
