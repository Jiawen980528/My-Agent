// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { PickModel } from './PickModel'

vi.mock('@/components/EChartsIntraday', () => ({ EChartsIntraday: () => <div>个股分钟图</div> }))

const apiMock = vi.hoisted(() => ({
  overviewMarket: vi.fn(async () => ({ as_of: '2026-11-10T10:30:00', quote_status: { is_trading_hours: true } })),
  sectorRotation: vi.fn(async () => ({ status: 'no_data' })),
  paperAccounts: vi.fn(async () => ({ accounts: [{ id: 'default', name: '模拟账户', status: 'active' }] })),
  paperOrderCreate: vi.fn(async () => ({ order: { status: 'pending' } })),
  klineMinute: vi.fn(async () => ({ date: '2026-11-10', source: 'live', rows: [{ datetime: '2026-11-10 10:30:00', open: 10, high: 10, low: 10, close: 10, volume: 100, amount: 1000 }] })),
  myagentResearchPool: vi.fn(async () => ({ items: [{ symbol: '000739.SZ', name: '普洛药业', theme: '创新药', segment: '原料药', role: '产业链', rationale: 'CDMO', source_date: '2026-11-02' }], sources: ['资料.xlsx'] })),
  myagentResearchPoolImport: vi.fn(async () => ({ count: 1, imported: 1, unresolved: 0, sources: ['资料.xlsx'] })),
}))
vi.mock('@/lib/api', () => ({ api: apiMock }))

let cleanup = async () => {}
afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('shows pool-and-model intersections and blocks paper buy until AI explicitly permits it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let aiReply = '结论：继续观察\n等待量价确认。'
  let quotePrice = 10.2
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    let body: unknown = { items: [] }
    if (url.endsWith('/scan/start') && init?.method === 'POST') body = { job_id: 'mock-job', status: 'pending' }
    if (url.endsWith('/scan/job/mock-job')) body = { status: 'complete', result: { items: [
      { symbol: '000739', name: '普洛药业', score: 80, latest_date: '2026-11-10' },
      { symbol: '600519', name: '贵州茅台', score: 99, latest_date: '2026-11-10' },
    ], count: 2 } }
    if (url.includes('/quotes?symbols=')) body = { source: '腾讯公开行情（非QMT）', items: [{ symbol: '000739', price: quotePrice, pct: 1.5 }] }
    if (url.endsWith('/ai') && init?.method === 'POST') body = { reply: aiReply }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const host = document.createElement('div')
  const root = createRoot(host)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cleanup = async () => { await act(async () => root.unmount()); queryClient.clear() }
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><PickModel /></QueryClientProvider></MemoryRouter>))
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes(label))!
  await act(async () => { button('扫描全市场').click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const shortlist = host.querySelector('section')!
  expect(shortlist.querySelectorAll('[aria-label="待观察个股"] > button')).toHaveLength(1)
  expect(shortlist.textContent).toContain('普洛药业')
  expect(shortlist.textContent).not.toContain('贵州茅台')
  expect(shortlist.textContent).toContain('个股分钟图')
  expect(apiMock.klineMinute).toHaveBeenCalledWith('000739.SZ', undefined, true)
  await act(async () => { button('物理AI').click() })
  expect(shortlist.querySelectorAll('[aria-label="待观察个股"] > button')).toHaveLength(0)
  await act(async () => { button('全部').click() })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(true)
  await act(async () => { button('AI量化复核').click() })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(true)
  const aiRequest = (vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith('/ai') && init?.method === 'POST')?.[1] as RequestInit)
  expect(JSON.parse(String(aiRequest.body)).symbol).toBe('000739')
  aiReply = '结论：可考虑模拟买入\n量价已核验。'
  await act(async () => { button('AI量化复核').click() })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(false)
  quotePrice = 10.5
  await act(async () => { await queryClient.refetchQueries({ queryKey: ['pick-model-quotes', '000739'] }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(true)
  quotePrice = 10.2
  await act(async () => { await queryClient.refetchQueries({ queryKey: ['pick-model-quotes', '000739'] }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button('模拟买入…').hasAttribute('disabled')).toBe(false)
  await act(async () => { button('模拟买入…').click() })
  expect(apiMock.paperOrderCreate).not.toHaveBeenCalled()
  await act(async () => { button('确认模拟买入').click() })
  expect(apiMock.paperOrderCreate).toHaveBeenCalledWith(
    { symbol: '000739.SZ', side: 'buy', qty: 100, order_type: 'market' }, 'default',
  )
})

it('reports a failed background scan without showing invented candidates', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input)
    const body = url.endsWith('/scan/start') ? { job_id: 'failed-job' }
      : url.endsWith('/scan/job/failed-job') ? { status: 'failed', error: '历史行情源暂不可用' }
        : { items: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const host = document.createElement('div')
  const root = createRoot(host)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cleanup = async () => { await act(async () => root.unmount()); queryClient.clear() }
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><PickModel /></QueryClientProvider></MemoryRouter>))
  const scan = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes('扫描全市场'))!
  await act(async () => { scan.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(host.textContent).toContain('历史行情源暂不可用')
  expect(host.querySelectorAll('[aria-label="待观察个股"] > button')).toHaveLength(0)
})
