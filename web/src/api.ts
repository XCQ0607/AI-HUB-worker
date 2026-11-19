export class ApiError extends Error {
  constructor(public status: number, msg: string) { super(msg) }
}

export async function api<T = any>(path: string, opt: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api/platform/v1' + path, {
    method: opt.method ?? (opt.body ? 'POST' : 'GET'),
    headers: opt.body ? { 'content-type': 'application/json' } : undefined,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`)
  return data as T
}

export async function uploadBinary<T = any>(path: string, file: File | Blob): Promise<T> {
  const res = await fetch('/api/platform/v1' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body: file,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`)
  return data as T
}

export const ago = (t?: number | null) => {
  if (!t) return '—'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return `${s | 0} 秒前`
  if (s < 3600) return `${(s / 60) | 0} 分钟前`
  if (s < 86400) return `${(s / 3600) | 0} 小时前`
  return `${(s / 86400) | 0} 天前`
}

export const fmtTime = (t?: number | null) => {
  if (!t) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

export const bytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}

export const shortId = (s: string, n = 22) => (s.length > n ? s.slice(0, n) + '…' : s)
