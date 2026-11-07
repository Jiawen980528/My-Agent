// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyFontScale, getFontScale, setFontScale } from './fontScale'
import { setUiPref } from './uiPrefs'

vi.mock('./uiPrefs', () => ({ setUiPref: vi.fn() }))

beforeEach(() => localStorage.clear())
afterEach(() => {
  document.documentElement.removeAttribute('style')
  vi.clearAllMocks()
})

it('applies readable default sizes and persists a separate font setting', () => {
  expect(getFontScale()).toBe(1)
  expect(applyFontScale(1)).toBe(1)
  expect(document.documentElement.style.getPropertyValue('--tf-font-9')).toBe('12px')
  expect(document.documentElement.style.getPropertyValue('--tf-font-xs')).toBe('14px')
  expect(setFontScale(1.2)).toBe(1.2)
  expect(document.documentElement.style.getPropertyValue('--tf-font-10')).toBe('15.6px')
  expect(setUiPref).toHaveBeenCalledWith('tf-font-scale', '1.2')
})

it('clamps out-of-range or invalid stored values', () => {
  localStorage.setItem('tf-font-scale', '2')
  expect(getFontScale()).toBe(1.3)
  expect(applyFontScale(-1)).toBe(0.85)
  localStorage.setItem('tf-font-scale', '"bad"')
  expect(getFontScale()).toBe(1)
})
