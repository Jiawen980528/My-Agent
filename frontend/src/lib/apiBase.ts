/** Keep browser requests inside the same mount as the application assets. */
export const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
export const apiUrl = (path: string): string => `${API_BASE}${path}`
