import { Hub, type Env } from './hub'
export { Hub }

const SEC: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'"
const LOCATIONS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'])

async function asset(req: Request, env: Env, path: string): Promise<Response> {
  let res = await env.ASSETS.fetch(new Request(new URL(path, req.url), req))
  // SPA fallback for client-side routes (anything without a file extension).
  if (res.status === 404 && !/\.[a-z0-9]+$/i.test(path)) res = await env.ASSETS.fetch(new Request(new URL('/platform/index.html', req.url), req))
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v)
  out.headers.set('content-security-policy', CSP)
  return out
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (pathname === '/platform' || pathname.startsWith('/platform/')) return asset(req, env, pathname === '/platform' ? '/platform/' : pathname)
    const hint = env.DO_LOCATION?.trim().toLowerCase()
    const opt = hint && LOCATIONS.has(hint) ? { locationHint: hint as DurableObjectLocationHint } : undefined
    const headers = new Headers(req.headers)
    headers.delete('x-aihub-colo'); headers.delete('x-aihub-country')
    const cf = (req as any).cf
    if (cf?.colo) headers.set('x-aihub-colo', String(cf.colo))
    if (cf?.country) headers.set('x-aihub-country', String(cf.country))
    const forwarded = new Request(req, { headers })
    // One global Hub: a tunnel's instanceId only arrives in its first frame and an accepted WebSocket cannot move between DOs.
    const res = await env.HUB.get(env.HUB.idFromName('hub'), opt).fetch(forwarded)
    if (res.status === 101) return res
    // Keep default encodeBody ('automatic'): env.HUB.get(...).fetch() auto-decompresses res.body
    // across the DO boundary, so setting encodeBody:'manual' here would corrupt compressed responses.
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v)
    return out
  },
} satisfies ExportedHandler<Env>
