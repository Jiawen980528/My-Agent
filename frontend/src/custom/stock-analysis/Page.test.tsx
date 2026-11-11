// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { StockAnalysis } from './Page'

const apiMock = vi.hoisted(() => ({
  klineDaily: vi.fn(async () => ({ rows: [] })),
  stockAnalysisLevels: vi.fn(async () => ({ levels: {} })),
}))
vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/lib/stockAnalysisStore', () => ({
  loadHistory: vi.fn(), useHistoryReports: () => ({ reports: [], loaded: true }),
  startAnalysis: vi.fn(), findTodayReport: vi.fn(), deleteReport: vi.fn(), openHistoryReport: vi.fn(),
}))
vi.mock('@/components/financials/StockFinancialSearch', () => ({ StockFinancialSearch: () => null }))
vi.mock('@/components/StockPreviewDialog', () => ({ StockPreviewDialog: () => null }))
vi.mock('@/components/stock-analysis/AnalysisKChart', () => ({ AnalysisKChart: () => null }))

it('opens the stock named in the URL instead of the previously viewed stock', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.setItem('last_stock:stock-analysis', JSON.stringify({ symbol: '000001.SZ', name: '旧股票' }))
  const host = document.createElement('div')
  const root = createRoot(host)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/stock-analysis?symbol=600519.SH&name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0']}>
        <QueryClientProvider client={queryClient}><StockAnalysis /></QueryClientProvider>
      </MemoryRouter>,
    ))
    expect(host.textContent).toContain('贵州茅台')
    expect(apiMock.klineDaily).toHaveBeenCalledWith('600519.SH', 250)
    expect(apiMock.klineDaily).not.toHaveBeenCalledWith('000001.SZ', 250)
  } finally {
    await act(async () => root.unmount())
    queryClient.clear()
    localStorage.clear()
  }
})
