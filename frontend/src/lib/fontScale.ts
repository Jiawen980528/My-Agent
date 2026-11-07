import { storage } from '@/lib/storage'
import { setUiPref } from '@/lib/uiPrefs'

export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.3
export const FONT_SCALE_STEP = 0.05
export const FONT_SCALE_DEFAULT = 1

const SIZES = [
  ['7', 12], ['8', 12], ['9', 12], ['10', 13], ['11', 14],
  ['12', 15], ['13', 16], ['14', 16], ['15', 17], ['16', 18], ['24', 26],
  ['body', 16], ['xs', 14], ['sm', 16], ['lg', 19], ['xl', 21], ['2xl', 25], ['3xl', 31],
] as const

function clamp(value: number): number {
  if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value * 100) / 100))
}

export function getFontScale(): number {
  return clamp(storage.fontScale.get(FONT_SCALE_DEFAULT))
}

export function applyFontScale(value: number): number {
  const scale = clamp(value)
  for (const [name, base] of SIZES) {
    document.documentElement.style.setProperty(`--tf-font-${name}`, `${Math.round(base * scale * 10) / 10}px`)
  }
  window.dispatchEvent(new Event('resize'))
  return scale
}

export function setFontScale(value: number): number {
  const scale = clamp(value)
  setUiPref('tf-font-scale', JSON.stringify(scale))
  return applyFontScale(scale)
}
