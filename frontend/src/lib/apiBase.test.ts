import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
it.each([['/quant/', '/quant/api/status'], ['/', '/api/status']])('keeps API requests under application base %s', async (base, expected) => {
  vi.resetModules()
  vi.stubEnv('BASE_URL', base)
  const { apiUrl } = await import('./apiBase')
  expect(apiUrl('/api/status')).toBe(expected)
})
