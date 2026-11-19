// DSH tunnel protocol v2 — mirrors reference/dsh-mobile-server/server/relay-core/protocol-types.js
// Frame: [type:1B][id:4B BE][length:4B BE][payload]. Checked by scripts/sync-reference.mjs.

export const T = {
  register: 0x01, registered: 0x02, updatePairing: 0x03,
  httpRequest: 0x04, httpBody: 0x05, httpHead: 0x06, httpChunk: 0x07, httpEnd: 0x08, httpError: 0x09,
  wsUpgrade: 0x0a, wsOpen: 0x0b, wsError: 0x0c, wsText: 0x0d, wsBinary: 0x0e, wsClose: 0x0f,
  ping: 0x10, pong: 0x11, pairRequest: 0x12, pairConfirm: 0x13,
  httpCancel: 0x14, httpPause: 0x15, httpResume: 0x16,
  sync: 0x17, revokeAll: 0x18, revokeAllAck: 0x19,
  pushRegister: 0x1a, pushSend: 0x1b, migrate: 0x1c, blobPut: 0x1d, blobDelete: 0x1e,
} as const

export const HEADER_LEN = 9
export const RESERVED_CLOSE_CODES = [1004, 1005, 1006, 1015]
export const OWNED_PATHS = ['/', '/healthz', '/status', '/api/mobile/v1/health', '/api/mobile/v1/push-token', '/tunnel']
export const MOBILE_PREFIX = '/api/mobile/v1/'

const enc = new TextEncoder()
const dec = new TextDecoder()
const EMPTY = new Uint8Array(0)

export function encodeFrame(type: number, id: number, payload: Uint8Array | string = EMPTY): ArrayBuffer {
  const body = typeof payload === 'string' ? enc.encode(payload) : payload
  const out = new Uint8Array(HEADER_LEN + body.length)
  const dv = new DataView(out.buffer)
  out[0] = type
  dv.setUint32(1, id >>> 0)
  dv.setUint32(5, body.length)
  out.set(body, HEADER_LEN)
  return out.buffer
}

export interface Frame { type: number; id: number; payload: Uint8Array }

export function decodeFrame(buf: ArrayBuffer): Frame | null {
  if (buf.byteLength < HEADER_LEN) return null
  const dv = new DataView(buf)
  const len = dv.getUint32(5)
  if (HEADER_LEN + len > buf.byteLength) return null
  return { type: dv.getUint8(0), id: dv.getUint32(1), payload: new Uint8Array(buf, HEADER_LEN, len) }
}

export const jsonFrame = (type: number, id: number, value: unknown) => encodeFrame(type, id, JSON.stringify(value))
export function parseJson(p: Uint8Array): any { try { return JSON.parse(dec.decode(p)) } catch { return null } }
export const text = (p: Uint8Array) => dec.decode(p)

export function validCloseCode(c: number) { return Number.isInteger(c) && c >= 1000 && c <= 4999 && !RESERVED_CLOSE_CODES.includes(c) }

export function normalizePath(p: string) {
  const c = p.replace(/\/{2,}/g, '/')
  return c.length > 1 && c.endsWith('/') ? c.slice(0, -1) : c
}
export function stripDeployPrefix(p: string) {
  if (OWNED_PATHS.includes(p)) return p
  const at = p.indexOf(MOBILE_PREFIX)
  if (at >= 0) return at > 0 ? p.slice(at) : p
  return OWNED_PATHS.find(o => o !== '/' && p.endsWith(o)) ?? p
}
/** Path sent to the host: deploy prefix stripped, query kept. */
export function routedPath(pathname: string, search = '') {
  const n = normalizePath(pathname)
  const s = stripDeployPrefix(n)
  return s + search
}
/** Block host control-plane paths (/api/relay and /api/relay/**, even under a deploy prefix). */
export function isControlPlanePath(pathname: string): boolean {
  return /(?:^|\/)api\/relay(?:\/|$)/.test(pathname)
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host'])
export const forwardable = (name: string) => !HOP.has(name.toLowerCase())

export function b64uEncode(b: Uint8Array) {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64uDecode(s: string) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export async function sha256Hex(s: string | Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('')
}
export function cmpVersion(a: string, b: string) {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1 }
  return 0
}

export function ctEq(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** Extract device credentials in upstream priority: X-Dsh-Device-Credential first, then Bearer token. */
export function presentedCredentials(req: Request): string[] {
  const out: string[] = []
  const hdr = (req.headers.get('x-dsh-device-credential') ?? '').trim()
  if (hdr) out.push(hdr)
  const auth = (req.headers.get('authorization') ?? '').trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? ''
  if (bearer && !out.includes(bearer)) out.push(bearer)
  return out
}
