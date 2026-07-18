export type UiModePreference = 'auto' | 'mobile' | 'desktop'
export type ResolvedUiMode = 'mobile' | 'desktop'

const STORAGE_KEY = 'osv_ui_mode'
const MOBILE_QUERY = '(max-width: 1023px)'

export function readUiModePreference(): UiModePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'mobile' || stored === 'desktop' ? stored : 'auto'
}

export function resolveUiMode(): ResolvedUiMode {
  const preference = readUiModePreference()
  if (preference !== 'auto') return preference
  return window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop'
}

/**
 * 整个会话固定一套产品壳，避免横竖屏切换时卸载正在填写的处置表单。
 * 用户显式切换版本后重载，下一次启动再选择新壳。
 */
export function switchUiMode(mode: ResolvedUiMode) {
  localStorage.setItem(STORAGE_KEY, mode)
  window.location.reload()
}

export function resetUiMode() {
  localStorage.removeItem(STORAGE_KEY)
  window.location.reload()
}
