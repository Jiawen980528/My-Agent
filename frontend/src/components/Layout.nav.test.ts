import { describe, expect, it } from 'vitest'
import { PRIMARY_NAV_PATHS } from './Layout'

describe('primary navigation', () => {
  it('keeps the standalone quant entry available', () => {
    expect(PRIMARY_NAV_PATHS).toContain('/myagent-quant')
  })

  it('keeps the holdings-first navigation compact', () => {
    expect(PRIMARY_NAV_PATHS).toEqual([
      '/',
      '/portfolio-terminal',
      '/decision-guide',
      '/recommendations',
      '/myagent-quant',
    ])
  })
})
