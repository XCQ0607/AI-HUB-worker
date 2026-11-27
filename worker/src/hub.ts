import { DurableObject } from 'cloudflare:workers'
import { Admin, json, normClaim, type AdminEnv, type Live, type TunnelInfo } from './admin'
import { MirrorStore } from './mirror'
import { OtaStore } from './ota'
import { WebhookService } from './webhook'
import {
  T, b64uDecode, b64uEncode, cmpVersion, ctEq, decodeFrame, encodeFrame, forwardable,
  isControlPlanePath, jsonFrame, normalizePath, parseJson, presentedCredentials, routedPath,
  sha256Hex, stripDeployPrefix, text, validCloseCode, type Frame,
} from './protocol'

export interface Env extends AdminEnv {
  HUB: DurableObjectNamespace<Hub>
  ASSETS: Fetcher
  DO_LOCATION?: string
}

interface TAtt { kind: 'tunnel'; tid: string; reg: boolean; instance: string; version: string; license: string; ip: string; created: number; seen: number; saved: number }
interface PAtt { kind: 'phone'; id: number; instance: string; tid: string }
interface Pend {
  tid: string; method: string; sse: boolean; device: string; created: number
  resolve: (r: Response) => void; ctrl?: ReadableStreamDefaultController<Uint8Array>
  headSent: boolean; paused: boolean; timer?: ReturnType<typeof setTimeout>; fallbackTimer?: ReturnType<typeof setTimeout>; sent: number
  /** 镜像上下文：只有可缓存的列表读请求才有值，用于上游 5xx 时回退旧列表。 */
  instance: string; mirror: { kind: 'sessions' | 'workspaces'; rev: string } | null; creds: string[]
}

/** 每条隧道最多一条在途分片上传；断线或空闲超时后丢弃。 */
interface PendingUpload {
  id: number; instance: string; scope: string; key: string; creds: string
  total: number; nextOffset: number; idleAt: number
  /** 已创建的 R2 multipart 会话；单条密文不超过一个 R2 分片时保持 null，最后直接 put。 */
  upload: R2MultipartUpload | null
  uploaded: R2UploadedPart[]
  /** 尚未攒满 R2_PART_BYTES 的字节，最多一个分片的量。 */
  pending: Uint8Array[]
  pendingBytes: number
}

const NOT_FOUND = 'not found'
const HEALTH = '{"ok":true,"service":"dsh-mobile-relay"}'
const CHUNK = 256 * 1024
const MAX_BODY = 67 * 1024 * 1024
const MAX_PENDING = 256
const MAX_WS_CONNECTIONS = 256
const MAX_WS_MSG = 8 * 1024 * 1024
const MAX_SSE_CONNECTIONS = 64
const MAX_SSE_PER_DEVICE = 3
const HEADER_TIMEOUT = 60_000
// 单条密文上限与上游 MAX_BLOB_BYTES 默认上限（64 MiB）一致；每实例总量 256 MiB，超限先淘汰该实例最旧条目。
const MAX_BLOB = 64 * 1024 * 1024, MAX_BLOB_INSTANCE = 256 * 1024 * 1024, BLOB_TTL = 7 * 86400_000
// 旧 id=0 整包路径的单条上限：base64 后约 6.7 MiB，留足 Workers WebSocket 单帧余量；
// 更大的密文必须走分片（见 blobUpload 能力协商）。
const MAX_BLOB_INLINE = 5 * 1024 * 1024
/** 分片上传的协议片长（解码后字节），与上游 blobstore/upload.rs 的 MAX_CHUNK_BYTES 一致。 */
const MAX_CHUNK_BYTES = 48 * 1024
/** R2 multipart 的固定分片长度：除末片外必须等长且不小于 5 MiB，因此按此粒度攒块后上传。 */
const R2_PART_BYTES = 5 * 1024 * 1024
/** 分片上传在两片之间的空闲上限，超时丢弃未完成上传（量片间空闲，不是整份耗时）。 */
const BLOB_UPLOAD_IDLE_MS = 90_000
const NULL_BODY = new Set([101, 204, 205, 304])
/** 镜像兜底响应的统一标记头：stale 表示这是旧列表，不是本次上游的真实结果。 */
const STALE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-relay-mirror': 'stale' } as const
const enc = new TextEncoder()
const notFound = () => new Response(NOT_FOUND, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
/** 按已知总长拼合若干字节块（上传攒块用）。 */
function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
function closeReason(s: string): string {
  if (enc.encode(s).byteLength <= 123) return s
  let out = '', bytes = 0
  for (const ch of s) {
    const n = enc.encode(ch).byteLength
    if (bytes + n > 123) break
    out += ch; bytes += n
  }
  return out
}

export class Hub extends DurableObject<Env> {
  private admin: Admin
  private mirror: MirrorStore
  private ota: OtaStore
  private webhook: WebhookService
  private pending = new Map<number, Pend>()
  private wsState = new Map<number, { ready: boolean; queue: (string | ArrayBuffer)[] }>()
  private pluginSeen = new Map<string, { version: string; at: number }>()
  private pluginRejected = new Map<string, { version: string; min: string; at: number }>()
  private seq = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1) || 1
  private unregTimeouts = 0
  private blobEvicted = 0
  private blobUploads = new Map<string, PendingUpload>()
  private lastSlaveReport = 0
  private lastBlobSweep = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.admin = new Admin(ctx.storage.sql, env)
    this.mirror = new MirrorStore(ctx.storage.sql)
    this.ota = new OtaStore(ctx.storage.sql, env)
    this.webhook = new WebhookService(ctx.storage.sql)
    if (this.admin.isSlave && env.PLATFORM_CLAIM_CODE?.trim()) {
      ctx.waitUntil(this.ensureAlarm(5000))
    }
  }

  // ---------- helpers ----------
  private nextId() {
    do { this.seq = (this.seq + 1) >>> 0 || 1 }
    while (this.pending.has(this.seq) || this.wsState.has(this.seq) || this.ctx.getWebSockets('p' + this.seq).length > 0)
    return this.seq
  }
  private tunnels(): { ws: WebSocket; att: TAtt }[] {
    return this.ctx.getWebSockets('tunnel').map(ws => ({ ws, att: ws.deserializeAttachment() as TAtt })).filter(x => x.att?.kind === 'tunnel')
  }
  private registered(instance: string) { return this.tunnels().filter(t => t.att.reg && t.att.instance === instance).pop() }
  private byTid(tid: string) { return this.tunnels().find(t => t.att.tid === tid) }
  private phoneById(id: number, tid: string): WebSocket | null {
    if (id === 0) return null
    const ws = this.ctx.getWebSockets('p' + id)[0]
    if (!ws) return null
    const patt = ws.deserializeAttachment() as PAtt | null
    return patt?.kind === 'phone' && patt.tid === tid ? ws : null
  }
  private async deleteR2Keys(bucket: R2Bucket, keys: string[]) {
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100)
      if (chunk.length) await bucket.delete(chunk)
    }
  }
  private send(ws: WebSocket, frame: ArrayBuffer) { try { ws.send(frame) } catch { /* closed */ } }
  private async ensureAlarm(ms: number) {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms)
  }

  private pluginSummary() {
    const cutoff = Date.now() - 3600_000
    const min = this.admin.minVersion
    for (const [k, v] of this.pluginRejected) {
      if (v.at < cutoff) this.pluginRejected.delete(k)
    }
    let seen = 0, outdated = 0
    for (const [k, v] of this.pluginSeen) {
      if (v.at < cutoff) { this.pluginSeen.delete(k); continue }
      seen++
      if (min && (!v.version || cmpVersion(v.version, min) < 0)) outdated++
    }
    return { seen, outdated, min: min || null }
  }

  private live: Live = {
    tunnels: (): TunnelInfo[] => this.tunnels().filter(t => t.att.reg && t.att.instance).map(t => ({
      id: t.att.instance, version: t.att.version, ip: t.att.ip, connectedAt: t.att.created,
      pending: [...this.pending.values()].filter(p => p.tid === t.att.tid).length,
    })),
    kick: (id: string) => {
      const t = this.registered(id)
      if (!t) return false
      try { t.ws.close(1000, 'kicked by admin') } catch { /* */ }
      this.dropTunnel(t.att.tid)
      return true
    },
    mirror: null as unknown as MirrorStore,
    ota: null as unknown as OtaStore,
    webhook: null as unknown as WebhookService,
    waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
    unregisteredTimeouts: () => this.unregTimeouts,
    listBlobs: () => {
      const rows = this.ctx.storage.sql.exec('SELECT instance, COUNT(*) c, COALESCE(SUM(size),0) b, MAX(updated) u FROM blobs GROUP BY instance ORDER BY u DESC LIMIT 200').toArray()
      return rows.map(r => ({ instance: String(r.instance), count: Number(r.c), bytes: Number(r.b), updated: Number(r.u) }))
    },
    clearBlobs: async (instance?: string) => {
      const bucket = this.env.BLOB
      const rows = instance
        ? this.ctx.storage.sql.exec('SELECT instance,scope,k FROM blobs WHERE instance=?', instance).toArray()
        : this.ctx.storage.sql.exec('SELECT instance,scope,k FROM blobs').toArray()
      if (bucket && rows.length) {
        await this.deleteR2Keys(bucket, rows.map(r => this.blobKey(String(r.instance), String(r.scope), String(r.k))))
      }
      if (instance) this.ctx.storage.sql.exec('DELETE FROM blobs WHERE instance=?', instance)
      else this.ctx.storage.sql.exec('DELETE FROM blobs')
    },
  }

  private getLive(): Live {
    this.live.mirror = this.mirror
    this.live.ota = this.ota
    this.live.webhook = this.webhook
    return this.live
  }

  // ---------- entry ----------
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = normalizePath(url.pathname)
    // Hard upstream guard: host control-plane paths (/api/relay and /api/relay/**) always return 404 before WS upgrade or routing.
    if (isControlPlanePath(path)) return notFound()

    const live = this.getLive()
    if (path.startsWith('/api/platform/v1/')) return this.admin.handle(req, path, live)
    if (path.startsWith('/api/desktop-plugins/ota/')) {
      const rest = path.slice('/api/desktop-plugins/ota/'.length)
      const isAdmin = req.method === 'POST' ? await this.admin.isAdmin(req) : false
      const res = await this.ota.handle(req, url, rest, isAdmin)
      if (res) return res
    }

    const route = stripDeployPrefix(path)
    switch (route) {
      case '/tunnel': return this.openTunnel(req)
      case '/healthz': return new Response('ok')
      case '/api/mobile/v1/health':
        return req.method === 'GET' ? new Response(HEALTH, { headers: { 'content-type': 'application/json' } }) : json(405, { ok: false, error: 'method not allowed' })
      case '/status': {
        if (!(await this.admin.isMonitorOrAdmin(req))) return notFound()
        const n = (q: string) => Number(this.ctx.storage.sql.exec(q).toArray()[0]?.c ?? 0)
        return json(200, {
          ok: true,
          hostConnected: live.tunnels().length > 0,
          tunnels: live.tunnels().length,
          mirror: this.mirror.stats(),
          blob: { enabled: !!this.env.BLOB, count: n('SELECT COUNT(*) c FROM blobs'), bytes: n('SELECT COALESCE(SUM(size),0) c FROM blobs'), evicted: this.blobEvicted },
          plugins: this.pluginSummary(),
          tunnelUnregisteredTimeouts: this.unregTimeouts,
        })
      }
      case '/': return notFound()
    }
    const bi = path.indexOf('/api/mobile/v1/blob/')
    if (bi >= 0 && this.env.BLOB) return this.blobGet(req, path.slice(bi + '/api/mobile/v1/blob/'.length))
    return this.forward(req, url, path)
  }

  // ---------- tunnel (host side) ----------
  private async openTunnel(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return notFound()
    const diag = new URL(req.url).searchParams.get('diag')
    if (diag && await this.admin.verifyDiagTicket(diag)) {
      const [client, server] = Object.values(new WebSocketPair())
      server.accept()
      server.send(JSON.stringify({ ok: true, diag: 'wss_ok', colo: req.headers.get('x-aihub-colo') || 'LOCAL' }))
      server.close(1000, 'diag_ok')
      return new Response(null, { status: 101, webSocket: client })
    }
    const err = this.admin.admit(req.headers.get('x-dsh-license') ?? '')
    if (err) return json(401, { code: 'admission_denied', message: err })
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['tunnel'])
    const now = Date.now()
    const att: TAtt = {
      kind: 'tunnel', tid: crypto.randomUUID(), reg: false, instance: '', version: '',
      license: req.headers.get('x-dsh-license') ?? '', ip: req.headers.get('cf-connecting-ip') ?? '',
      created: now, seen: now, saved: now,
    }
    server.serializeAttachment(att)
    await this.ensureAlarm(8500)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as TAtt | PAtt
    if (!att) return
    if (att.kind === 'phone') return this.phoneMessage(ws, att, msg)
    if (typeof msg === 'string') return
    const f = decodeFrame(msg)
    if (!f) return
    const now = Date.now()
    att.seen = now
    if (now - att.saved > 10_000) { att.saved = now; ws.serializeAttachment(att) }
    await this.tunnelFrame(ws, att, f)
  }

  private async tunnelFrame(ws: WebSocket, att: TAtt, f: Frame) {
    switch (f.type) {
      case T.ping: return this.send(ws, encodeFrame(T.pong, 0))
      case T.register: return this.onRegister(ws, att, f)
      case T.httpHead: return this.onHead(att, f)
      case T.httpChunk: {
        const p = this.pending.get(f.id)
        if (!p || p.tid !== att.tid || !p.ctrl) return
        if (f.payload.length) this.admin.recordTraffic(att.instance, 0, 0, f.payload.length)
        try { p.ctrl.enqueue(f.payload.slice()) } catch { return }
        if (!p.paused && (p.ctrl.desiredSize ?? 1) <= 0) { p.paused = true; this.send(ws, encodeFrame(T.httpPause, f.id)) }
        return
      }
      case T.httpEnd: {
        const p = this.pending.get(f.id)
        if (!p || p.tid !== att.tid) return
        this.pending.delete(f.id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
        try { p.ctrl?.close() } catch { /* */ }
        return
      }
      case T.httpError: {
        const p = this.pending.get(f.id)
        if (!p || p.tid !== att.tid) return
        this.finishError(f.id, p, parseJson(f.payload)?.message ?? 'upstream error', 502)
        return
      }
      case T.wsOpen: {
        if (!att.reg || !this.phoneById(f.id, att.tid)) return
        const st = this.wsState.get(f.id)
        if (!st) return
        st.ready = true
        for (const m of st.queue.splice(0)) this.send(ws, typeof m === 'string' ? encodeFrame(T.wsText, f.id, m) : encodeFrame(T.wsBinary, f.id, new Uint8Array(m)))
        return
      }
      case T.wsError: {
        if (!att.reg) return
        const phone = this.phoneById(f.id, att.tid)
        if (!phone) return
        this.wsState.delete(f.id)
        try { phone.close(1011, closeReason(parseJson(f.payload)?.message ?? 'upstream ws error')) } catch { /* */ }
        return
      }
      case T.wsText: case T.wsBinary: {
        if (!att.reg) return
        const phone = this.phoneById(f.id, att.tid)
        if (!phone) return
        try { f.type === T.wsText ? phone.send(text(f.payload)) : phone.send(f.payload.slice().buffer) } catch { /* */ }
        return
      }
      case T.wsClose: {
        if (!att.reg) return
        const phone = this.phoneById(f.id, att.tid)
        if (!phone) return
        this.wsState.delete(f.id)
        let code = 1000, reason = ''
        if (f.payload.length >= 2) { code = new DataView(f.payload.buffer, f.payload.byteOffset).getUint16(0); reason = text(f.payload.subarray(2)) }
        try { phone.close(validCloseCode(code) ? code : 1000, closeReason(reason)) } catch { /* */ }
        return
      }
      case T.sync: {
        if (!att.reg || !att.instance) return
        this.mirror.remember(att.instance, parseJson(f.payload), this.admin.mirrorEnabled)
        return
      }
      case T.blobPut: await this.blobPut(ws, att, f.id, parseJson(f.payload)); return
      case T.blobDelete: await this.blobDelete(att, parseJson(f.payload)); return
      case T.revokeAll: return this.send(ws, jsonFrame(T.revokeAllAck, 0, { ok: true, revoked: 0 }))
      default: return
    }
  }

  private onRegister(ws: WebSocket, att: TAtt, f: Frame) {
    const r = parseJson(f.payload) ?? {}
    const instance = String(r.instanceId ?? '').trim().slice(0, 200)
    const version = String(r.version ?? '').slice(0, 32)
    const now = Date.now()
    if (instance) this.pluginSeen.set(instance, { version, at: now })
    const reject = (message: string, extra: object = {}) => {
      this.send(ws, jsonFrame(T.wsError, 0, { message, ...extra }))
      try { ws.close(1008, closeReason(message)) } catch { /* */ }
      this.dropTunnel(att.tid)
    }
    if (instance && /[\/\x00-\x1f\x7f]/.test(instance)) return reject('invalid instanceId', { code: 'invalid_instance' })
    const license = String(r.license || att.license || '')
    const err = this.admin.admit(license, instance)
    if (err) return reject(err)
    const secret = this.env.TUNNEL_REGISTER_SECRET
    if (secret && !ctEq(String(r.secret ?? ''), secret)) return reject('bad registration secret', { code: 'bad_register_secret' })
    const min = this.admin.minVersion
    if (min && (!version || cmpVersion(version, min) < 0)) {
      if (instance) {
        this.pluginRejected.set(instance, { version, min, at: now })
        this.ctx.waitUntil(this.webhook.alert('plugin.outdated', instance, '旧版本插件被拦截', `实例 ${instance} 版本 ${version || '未知'} 低于最低要求 ${min}`, instance))
      }
      return reject(`plugin too old (min ${min})`, { code: 'plugin_too_old', min, have: version, retryAfterMs: 1_800_000 })
    }
    if (instance) this.pluginRejected.delete(instance)
    if (att.reg && att.instance && att.instance !== instance) return reject('one tunnel can only bind one instance', { code: 'instance_mismatch' })
    if (instance) {
      for (const o of this.tunnels()) {
        if (o.att.tid !== att.tid && o.att.reg && o.att.instance === instance) {
          o.att.reg = false
          try { o.ws.serializeAttachment(o.att) } catch { /* */ }
          this.dropTunnel(o.att.tid)
          try { o.ws.close(1000, 'superseded') } catch { /* */ }
        }
      }
      this.admin.touchInstance(instance, version, att.ip, license)
    }
    att.reg = true; att.instance = instance; att.version = version; att.license = license; att.saved = now
    ws.serializeAttachment(att)
    // blobUpload 声明本连接的分片能力；宿主据此决定走分片还是旧整包。无 R2 时不下发，
    // 宿主自动回退到 blobPut id=0 整包语义。
    const registeredAck: Record<string, unknown> = { ok: true, mirror: this.admin.mirrorEnabled }
    if (this.env.BLOB) registeredAck.blobUpload = { maxChunkBytes: MAX_CHUNK_BYTES, maxBlobBytes: MAX_BLOB }
    this.send(ws, jsonFrame(T.registered, 0, registeredAck))
  }

  private async onHead(att: TAtt, f: Frame) {
    const p = this.pending.get(f.id)
    if (!p || p.tid !== att.tid || p.headSent) return
    const h = parseJson(f.payload) ?? {}
    const rawStatus = Number(h.status)
    const status = Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502
    const headers = new Headers()
    for (const [k, v] of Object.entries(h.headers ?? {})) {
      if (!forwardable(k) && k.toLowerCase() !== 'content-length') continue
      try { Array.isArray(v) ? v.forEach(x => headers.append(k, String(x))) : headers.set(k, String(v)) } catch { /* bad header */ }
    }

    // 上游 5xx：可缓存的列表读请求优先回退到已过凭据校验的旧镜像，并如实标记 stale。
    // 与弱网超时回退的区别是本路径没有等待——上游已经明确失败，不必再等。
    if (status >= 500 && p.mirror) {
      const hit = await this.mirror.lookup(p.instance, p.mirror.kind, p.mirror.rev, p.creds)
      if (hit && !p.headSent) {
        this.pending.delete(f.id)
        clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
        p.headSent = true
        const t = this.byTid(p.tid)
        if (t) this.send(t.ws, encodeFrame(T.httpCancel, f.id))
        this.admin.recordTraffic(p.instance, 0, 0, enc.encode(hit).byteLength, true)
        p.resolve(new Response(hit, { status: 200, headers: { ...STALE_HEADERS } }))
        return
      }
    }

    p.headSent = true; clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
    if (NULL_BODY.has(status) || p.method === 'HEAD') {
      this.pending.delete(f.id)
      p.resolve(new Response(null, { status, headers }))
      return
    }
    const id = f.id
    const stream = new ReadableStream<Uint8Array>({
      start: c => { p.ctrl = c },
      pull: () => { if (p.paused) { p.paused = false; const t = this.byTid(p.tid); if (t) this.send(t.ws, encodeFrame(T.httpResume, id)) } },
      cancel: () => this.cancel(id),
    }, { highWaterMark: 4 * 1024 * 1024, size: (c: Uint8Array) => c.byteLength })
    const init: ResponseInit = { status, headers }
    // Preserve pre-encoded upstream bytes out of the DO; worker/src/index.ts intentionally keeps default
    // encodeBody ('automatic') because env.HUB.get(...).fetch() auto-decompresses res.body across the DO boundary.
    if (headers.has('content-encoding')) init.encodeBody = 'manual'
    p.resolve(new Response(stream, init))
  }

  private finishError(id: number, p: Pend, message: string, status: number) {
    this.pending.delete(id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
    if (!p.headSent) { p.headSent = true; p.resolve(json(status, { ok: false, error: message })) }
    else try { p.ctrl?.error(new Error(message)) } catch { /* */ }
  }

  private cancel(id: number, status = 499, error = 'request cancelled') {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
    const t = this.byTid(p.tid)
    if (t) this.send(t.ws, encodeFrame(T.httpCancel, id))
    if (!p.headSent) { p.headSent = true; p.resolve(json(status, { ok: false, error })) }
    else try { p.ctrl?.error(new Error(error)) } catch { /* already closed */ }
  }

  private dropTunnel(tid: string) {
    const pending = this.blobUploads.get(tid)
    this.blobUploads.delete(tid)
    if (pending?.upload) this.ctx.waitUntil(pending.upload.abort().catch(() => { /* 已过期 */ }))
    for (const [id, p] of [...this.pending]) if (p.tid === tid) this.finishError(id, p, 'upstream unavailable', 502)
    for (const ws of this.ctx.getWebSockets('phone')) {
      const a = ws.deserializeAttachment() as PAtt
      if (a?.tid === tid) { this.wsState.delete(a.id); try { ws.close(1012, 'tunnel closed') } catch { /* */ } }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const att = ws.deserializeAttachment() as TAtt | PAtt
    if (att?.kind === 'phone') {
      this.wsState.delete(att.id)
      const t = this.byTid(att.tid)
      if (t) {
        const rb = new TextEncoder().encode(closeReason(reason))
        const out = new Uint8Array(2 + rb.length)
        new DataView(out.buffer).setUint16(0, validCloseCode(code) ? code : 1000)
        out.set(rb, 2)
        this.send(t.ws, encodeFrame(T.wsClose, att.id, out))
      }
    } else if (att?.kind === 'tunnel') {
      this.dropTunnel(att.tid)
      if (att.instance) {
        this.mirror.flush(att.instance)
        this.admin.flushMetrics()
        this.admin.markSeen(att.instance)
        if (att.reg && code !== 1000 && !['superseded', 'kicked by admin', 'heartbeat timeout'].includes(reason)) {
          this.ctx.waitUntil(this.webhook.alert('host.disconnect', att.instance, '宿主隧道意外断开', `实例 ${att.instance} 断开 (code=${code}, ${reason || '无原因'})`, att.instance))
        }
      }
    }
    try { ws.close(validCloseCode(code) ? code : 1000, closeReason(reason)) } catch { /* already closed */ }
    const isSlave = this.admin.isSlave && Boolean(this.env.PLATFORM_CLAIM_CODE?.trim())
    if (att?.kind === 'tunnel' && !isSlave) {
      const remaining = this.tunnels().filter(t => t.ws !== ws)
      if (remaining.length === 0) await this.ctx.storage.deleteAlarm()
    }
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws, 1011, 'error') }

  private async reportToMaster(now: number, allowFollowUp = true) {
    const master = this.env.PLATFORM_MASTER_URL?.trim()
    const claim = this.env.PLATFORM_CLAIM_CODE?.trim()
    if (!master || !claim) return
    this.lastSlaveReport = now
    const prevMode = this.admin.mode
    this.admin.flushMetrics()
    const sql = this.ctx.storage.sql
    const regTunnels = this.tunnels().filter(t => t.att.reg)
    const now24h = now - 24 * 3_600_000
    const licCount = Number(sql.exec('SELECT COUNT(*) c FROM licenses').toArray()[0]?.c ?? 0)
    const activeLicCount = Number(sql.exec("SELECT COUNT(*) c FROM licenses WHERE status='active' AND (expires_at IS NULL OR expires_at>?)", now).toArray()[0]?.c ?? 0)
    const devCount = Number(sql.exec("SELECT COUNT(*) c FROM license_devices WHERE status='active'").toArray()[0]?.c ?? 0)
    const instCount = Number(sql.exec('SELECT COUNT(*) c FROM instances').toArray()[0]?.c ?? 0)
    const m24 = sql.exec('SELECT COALESCE(SUM(reqs),0) reqs, COALESCE(SUM(bytes_in),0) bin, COALESCE(SUM(bytes_out),0) bout, COALESCE(SUM(mirror_hits),0) mh FROM metrics_hourly WHERE hour >= ?', now24h).toArray()[0]
    const blobRow = sql.exec('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM blobs').toArray()[0]
    const mirror = this.mirror.stats()
    const reportIntervalSeconds = Math.max(30, Number(this.env.PLATFORM_REPORT_INTERVAL_SECONDS) || 300)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-dsh-claim': normClaim(claim),
    }
    if (this.env.PLATFORM_MASTER_TOKEN?.trim()) headers.authorization = `Bearer ${this.env.PLATFORM_MASTER_TOKEN.trim()}`
    try {
      const res = await fetch(`${master.replace(/\/+$/, '')}/api/platform/v1/nodes/report`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          name: this.env.PLATFORM_NODE_NAME || 'AI-HUB Worker',
          publicUrl: this.env.PUBLIC_BASE_URL || '',
          admissionMode: this.admin.mode,
          licenseCount: licCount,
          activeLicenseCount: activeLicCount,
          deviceCount: devCount,
          tunnelOnline: regTunnels.length > 0,
          tunnelsOnline: regTunnels.length,
          instances: instCount,
          reqs24h: Number(m24?.reqs ?? 0),
          bytesIn24h: Number(m24?.bin ?? 0),
          bytesOut24h: Number(m24?.bout ?? 0),
          mirrorHits24h: Number(m24?.mh ?? 0),
          r2Enabled: Boolean(this.env.BLOB),
          blobCount: Number(blobRow?.c ?? 0),
          blobBytes: Number(blobRow?.b ?? 0),
          mirrorEnabled: this.admin.mirrorEnabled,
          mirrorInstances: mirror.instances,
          mirrorBytes: mirror.bytes,
          doLocation: (this.env.DO_LOCATION ?? '').trim().toLowerCase(),
          minVersion: this.admin.minVersion,
          reportIntervalSeconds,
          onlineHosts: regTunnels.slice(0, 5).map(t => ({ id: t.att.instance, version: t.att.version })),
        }),
      })
      if (!res.ok) {
        this.admin.setSetting('master_last_error', `HTTP ${res.status} ${await res.text().catch(() => '')}`)
        return
      }
      const data: any = await res.json().catch(() => ({}))
      let modeChanged = false
      if (data?.admissionMode === 'open' || data?.admissionMode === 'restricted') {
        this.admin.setSetting('master_manages_mode', '1')
        this.admin.setSetting('admission_mode', data.admissionMode)
        modeChanged = data.admissionMode !== prevMode
      } else if (data?.admissionMode === null || data?.managed === false) {
        this.admin.setSetting('master_manages_mode', '0')
      }
      this.admin.setSetting('master_last_report_at', String(now))
      this.admin.setSetting('master_last_error', '')
      if (allowFollowUp && modeChanged) await this.reportToMaster(Date.now(), false)
    } catch (e: any) {
      this.admin.setSetting('master_last_error', e?.message ?? String(e))
    }
  }

  async alarm() {
    const now = Date.now()
    const hbMs = this.admin.heartbeatMs
    const deadMs = Math.max(90_000, hbMs * 2 + 10_000)
    let any = false, unreg = false
    for (const { ws, att } of this.tunnels()) {
      if (!att.reg && now - att.created > 8000) {
        this.unregTimeouts++
        try { ws.close(1008, 'register timeout') } catch { /* */ }
        this.dropTunnel(att.tid); continue
      }
      if (now - att.seen > deadMs) {
        if (att.instance) {
          this.mirror.flush(att.instance)
          if (att.reg) this.ctx.waitUntil(this.webhook.alert('host.disconnect', att.instance, '宿主心跳超时离线', `实例 ${att.instance} 超过 ${Math.round(deadMs / 1000)}s 未响应心跳`, att.instance))
        }
        try { ws.close(1001, 'heartbeat timeout') } catch { /* */ }
        this.dropTunnel(att.tid); continue
      }
      this.send(ws, encodeFrame(T.ping, 0))
      any = true; unreg ||= !att.reg
    }

    // 回收片间空闲超时的未完成上传；旧完整 blob 不受影响，已创建的 R2 multipart 会话一并中止。
    for (const [tid, up] of [...this.blobUploads]) {
      if (now - up.idleAt <= BLOB_UPLOAD_IDLE_MS) continue
      this.blobUploads.delete(tid)
      if (up.upload) { try { await up.upload.abort() } catch { /* 已过期 */ } }
    }

    const slaveInterval = Math.max(30, Number(this.env.PLATFORM_REPORT_INTERVAL_SECONDS) || 300) * 1000
    const isSlave = this.admin.isSlave && Boolean(this.env.PLATFORM_CLAIM_CODE?.trim())
    if (isSlave && now - this.lastSlaveReport >= slaveInterval) await this.reportToMaster(now)
    if (this.env.BLOB && now - this.lastBlobSweep >= 3600_000) {
      this.lastBlobSweep = now
      await this.evictExpiredBlobs()
    }
    this.mirror.flush()
    this.admin.flushMetrics()

    let next = any ? (unreg ? 8000 : hbMs) : 0
    if (isSlave) next = next ? Math.min(next, slaveInterval) : slaveInterval
    if (next) await this.ctx.storage.setAlarm(now + next)
    else await this.ctx.storage.deleteAlarm()
  }

  // ---------- phone side ----------
  private async forward(req: Request, url: URL, path: string): Promise<Response> {
    const instance = (req.headers.get('x-dsh-instance') ?? '').trim()
    const cleanPath = routedPath(url.pathname)
    const mirrorRead = this.admin.mirrorEnabled ? this.mirror.parseRead(req.method, cleanPath, url.search) : null

    let tun = instance ? this.registered(instance) : undefined
    if (!instance) {
      if (cleanPath === '/api/mobile/v1/pair') {
        const all = this.tunnels().filter(t => t.att.reg && t.att.instance)
        if (all.length === 1) tun = all[0]
        else if (all.length === 0) return json(503, { ok: false, error: 'missing x-dsh-instance header' })
        else return json(503, { ok: false, error: 'this relay has more than one host online; scan the QR code instead of typing the pairing code' })
      } else {
        return notFound()
      }
    } else if (!tun) {
      if (mirrorRead) {
        const hit = await this.mirror.lookup(instance, mirrorRead.kind, mirrorRead.rev, presentedCredentials(req))
        if (hit) {
          this.admin.recordTraffic(instance, 1, 0, enc.encode(hit).byteLength, true)
          this.admin.flushMetrics()
          return new Response(hit, { status: 200, headers: STALE_HEADERS })
        }
      }
      const rej = this.pluginRejected.get(instance)
      const curMin = this.admin.minVersion
      if (rej && Date.now() - rej.at < 3600_000 && curMin && (!rej.version || cmpVersion(rej.version, curMin) < 0)) {
        return json(503, {
          ok: false, code: 'plugin_too_old', min: curMin, have: rej.version,
          error: `desktop plugin ${rej.version || '0.0.0'} is older than required ${curMin}`,
        })
      } else if (rej) {
        this.pluginRejected.delete(instance)
      }
      return json(503, { ok: false, error: 'that host is not connected to this relay' })
    }
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.phoneUpgrade(req, tun!, url)
    return this.forwardHttp(req, tun!, url, instance || tun!.att.instance, mirrorRead)
  }

  private cleanHeaders(req: Request, ws = false) {
    const out: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (!forwardable(k) || k.startsWith('cf-') || k === 'x-aihub-colo' || k === 'x-aihub-country' || k === 'cdn-loop' || k === 'x-real-ip' || (ws && k.startsWith('sec-websocket-') && k !== 'sec-websocket-protocol')) return
      out[k] = v
    })
    const ip = req.headers.get('cf-connecting-ip')
    if (ip) out['x-real-ip'] = ip
    return out
  }

  private forwardHttp(
    req: Request,
    tun: { ws: WebSocket; att: TAtt },
    url: URL,
    instance: string,
    mirrorRead: { kind: 'sessions' | 'workspaces'; rev: string } | null,
  ): Promise<Response> {
    const tid = tun.att.tid
    const isSse = (req.headers.get('accept') ?? '').toLowerCase().includes('text/event-stream')
    const device = (req.headers.get('x-dsh-device') ?? '').trim() || presentedCredentials(req)[0] || '<unknown>'

    // Per-tunnel MAX_PENDING and SSE top-flow eviction (MAX_SSE_PER_DEVICE = 3, MAX_SSE_CONNECTIONS = 64).
    const tunPend: [number, Pend][] = []
    for (const [pid, p] of this.pending) if (p.tid === tid) tunPend.push([pid, p])
    let evicted = 0
    if (isSse) {
      const devSse = tunPend.filter(([, p]) => p.sse && p.device === device).sort((a, b) => a[1].created - b[1].created)
      while (devSse.length >= MAX_SSE_PER_DEVICE) {
        const [oldId, oldP] = devSse.shift()!
        this.finishError(oldId, oldP, 'sse superseded by newer stream from same device', 409)
        this.send(tun.ws, encodeFrame(T.httpCancel, oldId))
        evicted++
      }
      const totalSse = tunPend.filter(([, p]) => p.sse).length - evicted
      if (totalSse >= MAX_SSE_CONNECTIONS) return Promise.resolve(json(429, { ok: false, error: 'too many sse connections' }, { 'retry-after': '25' }))
    }
    const activeCount = tunPend.length - evicted
    if (activeCount >= MAX_PENDING) return Promise.resolve(json(429, { ok: false, error: 'too many pending requests' }, { 'retry-after': '25' }))

    const id = this.nextId()
    const creds = mirrorRead ? presentedCredentials(req) : []
    const fallbackMs = mirrorRead ? this.admin.mirrorFallbackMs : 0

    return new Promise<Response>(resolve => {
      const p: Pend = {
        tid, method: req.method, sse: isSse, device, created: Date.now(), resolve, headSent: false, paused: false, sent: 0,
        instance, mirror: mirrorRead, creds,
      }
      p.timer = setTimeout(() => {
        this.cancel(id, 504, 'upstream header timeout')
      }, HEADER_TIMEOUT)
      if (mirrorRead && fallbackMs > 0) {
        p.fallbackTimer = setTimeout(async () => {
          if (p.headSent) return
          const hit = await this.mirror.lookup(instance, mirrorRead.kind, mirrorRead.rev, creds)
          if (hit && !p.headSent && this.pending.has(id)) {
            this.pending.delete(id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
            const t = this.byTid(p.tid)
            if (t) this.send(t.ws, encodeFrame(T.httpCancel, id))
            p.headSent = true
            this.admin.recordTraffic(instance, 0, 0, enc.encode(hit).byteLength, true)
            this.admin.flushMetrics()
            resolve(new Response(hit, {
              status: 200,
              headers: STALE_HEADERS,
            }))
          }
        }, fallbackMs)
      }
      this.pending.set(id, p)
      this.send(tun.ws, jsonFrame(T.httpRequest, id, { method: req.method, path: routedPath(url.pathname, url.search), headers: this.cleanHeaders(req) }))
      req.signal.addEventListener('abort', () => this.cancel(id))
      ;(async () => {
        try {
          if (req.body) {
            const rd = req.body.getReader()
            for (;;) {
              const { done, value } = await rd.read()
              if (done) break
              if (!this.pending.has(id)) return
              p.sent += value.length
              this.admin.recordTraffic(instance, 0, value.length, 0)
              if (p.sent > MAX_BODY) { this.finishError(id, p, 'request body too large', 413); this.send(tun.ws, encodeFrame(T.httpCancel, id)); return }
              for (let o = 0; o < value.length; o += CHUNK) {
                if (!this.pending.has(id)) return
                this.send(tun.ws, encodeFrame(T.httpBody, id, value.subarray(o, o + CHUNK)))
              }
            }
          }
          if (!this.pending.has(id)) return
          this.admin.recordTraffic(instance, 1, 0, 0)
          this.send(tun.ws, encodeFrame(T.httpBody, id))
        } catch { this.cancel(id) }
      })()
    })
  }

  private phoneUpgrade(req: Request, tun: { ws: WebSocket; att: TAtt }, url: URL): Response {
    const tunWs = this.ctx.getWebSockets('phone').filter(w => (w.deserializeAttachment() as PAtt | null)?.tid === tun.att.tid).length
    if (tunWs >= MAX_WS_CONNECTIONS) return json(429, { ok: false, error: 'too many websocket connections' }, { 'retry-after': '25' })
    const id = this.nextId()
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['phone', 'p' + id])
    server.serializeAttachment({ kind: 'phone', id, instance: tun.att.instance, tid: tun.att.tid } satisfies PAtt)
    this.wsState.set(id, { ready: false, queue: [] })
    this.send(tun.ws, jsonFrame(T.wsUpgrade, id, { path: routedPath(url.pathname, url.search), headers: this.cleanHeaders(req, true) }))
    setTimeout(() => {
      if (this.wsState.get(id)?.ready === false) {
        this.wsState.delete(id)
        const t = this.byTid(tun.att.tid)
        if (t) {
          const rb = enc.encode('host did not open ws')
          const out = new Uint8Array(2 + rb.length)
          new DataView(out.buffer).setUint16(0, 1013)
          out.set(rb, 2)
          this.send(t.ws, encodeFrame(T.wsClose, id, out))
        }
        try { server.close(1013, 'host did not open ws') } catch { /* */ }
      }
    }, 15_000)
    return new Response(null, { status: 101, webSocket: client })
  }

  private phoneMessage(ws: WebSocket, att: PAtt, msg: string | ArrayBuffer) {
    const t = this.byTid(att.tid)
    if (!t) { try { ws.close(1012, 'tunnel closed') } catch { /* */ } return }
    const byteLen = typeof msg === 'string' ? enc.encode(msg).byteLength : msg.byteLength
    if (byteLen > MAX_WS_MSG) { try { ws.close(1009, 'message too large') } catch { /* */ } return }
    const st = this.wsState.get(att.id)
    if (st && !st.ready) { if (st.queue.length < 256) st.queue.push(msg); return }
    this.send(t.ws, typeof msg === 'string' ? encodeFrame(T.wsText, att.id, msg) : encodeFrame(T.wsBinary, att.id, new Uint8Array(msg)))
  }

  // ---------- blobs (optional R2) ----------
  private blobKey(inst: string, scope: string, key: string) { return `${encodeURIComponent(inst)}/${scope}/${key}` }

  /** 解析并校验宿主上报的设备凭据摘要；返回 JSON 文本，非法时返回 null。 */
  private parseBlobCreds(raw: unknown): string | null {
    if (!Array.isArray(raw)) return '[]'
    if (raw.length > 200) return null
    const out: { hash: string; expiresAt: number }[] = []
    for (const c of raw) {
      const rawHash = typeof c === 'string' ? c : c?.hash
      const hash = typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : ''
      if (!/^[0-9a-f]{64}$/.test(hash)) continue
      out.push({ hash, expiresAt: Math.max(0, Number(c?.expiresAt) || 0) })
    }
    return JSON.stringify(out)
  }

  /** 整包写入（旧 blobPut id=0 与分片收尾共用）。 */
  private async blobWrite(att: TAtt, scope: string, key: string, creds: string, bytes: Uint8Array) {
    const bucket = this.env.BLOB!, sql = this.ctx.storage.sql
    await bucket.put(this.blobKey(att.instance, scope, key), bytes)
    sql.exec(`INSERT INTO blobs(instance,scope,k,creds,size,updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(instance,scope,k) DO UPDATE SET creds=excluded.creds,size=excluded.size,updated=excluded.updated`,
      att.instance, scope, key, creds, bytes.length, Date.now())
    await this.blobEvict(att.instance)
  }

  private async blobPut(ws: WebSocket, att: TAtt, id: number, r: any) {
    const bucket = this.env.BLOB, sql = this.ctx.storage.sql
    if (!bucket || !att.reg || !att.instance || !r) return
    const scope = r.scope, key = String(r.key ?? '').trim()

    // id !== 0：分片上传。首片带 scope/key/creds，后续片只带 offset/total/final/cipher。
    if (id !== 0) return this.blobPutChunk(ws, att, id, r)

    // id === 0：旧整包语义，保持不变。
    if (!['messages', 'file'].includes(scope) || !key || key.length > 512) return
    const creds = this.parseBlobCreds(r.creds)
    if (creds === null) return
    if (typeof r.cipher === 'string' && r.cipher) {
      let bytes: Uint8Array
      try { bytes = b64uDecode(r.cipher) } catch { return }
      if (bytes.length > MAX_BLOB_INLINE) return
      await this.blobWrite(att, scope, key, creds, bytes)
    } else if (r.cipher === '' && creds !== '[]') {
      sql.exec('UPDATE blobs SET creds=? WHERE instance=? AND scope=? AND k=?', creds, att.instance, scope, key)
    }
  }

  /**
   * 分片上传：宿主一次只发一片、收到 ack 才发下一片。
   * 校验规则与上游 PROTOCOL.md 一致：offset 必须等于已确认的 nextOffset，
   * 非尾片 offset+片长 < total 且 final:false，尾片 offset+片长 === total 且 final:true。
   */
  private async blobPutChunk(ws: WebSocket, att: TAtt, id: number, r: any) {
    const now = Date.now()
    // 失败 ack 会丢弃本次临时上传，旧的完整 blob 保持可读；宿主保留 dirty 由下一轮以新 id 从零重推。
    const fail = async (error: string) => {
      const up = this.blobUploads.get(att.tid)
      this.blobUploads.delete(att.tid)
      // 已经创建过 multipart 会话的要中止，避免 R2 侧残留。
      if (up?.upload) { try { await up.upload.abort() } catch { /* 已 abort 或过期 */ } }
      this.send(ws, encodeFrame(T.blobPut, id, JSON.stringify({ ok: false, nextOffset: 0, done: false, error })))
    }

    // 宿主失败后会用新 id 从零重推（见 PROTOCOL.md），此时丢弃旧临时上传、接受新 id；
    // 迟到的旧 id ack 不会再被应答。
    let up = this.blobUploads.get(att.tid)
    // 新 id 到达：静默丢弃旧上传（旧 id 的迟到 ack 不再应答），让新上传从头开始。
    if (up && up.id !== id) {
      this.blobUploads.delete(att.tid)
      if (up.upload) { try { await up.upload.abort() } catch { /* 已过期 */ } }
      up = undefined
    }
    if (!up || now - up.idleAt > BLOB_UPLOAD_IDLE_MS) {
      if (up) { this.blobUploads.delete(att.tid); if (up.upload) { try { await up.upload.abort() } catch { /* */ } } }
      const scope = r.scope, key = String(r.key ?? '').trim()
      if (!['messages', 'file'].includes(scope)) return fail('invalid scope')
      if (!key || key.length > 512) return fail('invalid key')
      const creds = this.parseBlobCreds(r.creds)
      if (creds === null) return fail('invalid creds')
      const total = Number(r.total)
      if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_BLOB) return fail('invalid total')
      // 首片必须从 offset 0 开始。
      if (Number(r.offset) !== 0) return fail('first chunk must start at offset 0')
      up = {
        id, instance: att.instance, scope, key, creds, total, nextOffset: 0, idleAt: now,
        upload: null, uploaded: [], pending: [], pendingBytes: 0,
      }
      this.blobUploads.set(att.tid, up)
    }
    up.idleAt = now

    const offset = Number(r.offset)
    if (!Number.isSafeInteger(offset) || offset !== up.nextOffset) return fail('offset mismatch')
    const total = Number(r.total)
    if (Number.isSafeInteger(total) && total !== up.total) return fail('total mismatch')
    const final = r.final === true

    let chunk: Uint8Array
    try { chunk = b64uDecode(String(r.cipher ?? '')) } catch { return fail('invalid cipher') }
    if (!chunk.length) return fail('empty chunk')
    if (chunk.length > MAX_CHUNK_BYTES) return fail('chunk too large')
    const end = offset + chunk.length
    if (final ? end !== up.total : end >= up.total) return fail('invalid chunk boundary')

    up.nextOffset = end
    up.pending.push(chunk)
    up.pendingBytes += chunk.length

    // 攒满一个 R2 分片就上传；单条密文放得下一个分片时不建 multipart，最后直接 put。
    try {
      // 严格大于才切：正好 R2_PART_BYTES 的密文留在缓冲里，最后走单次 put，省一次 multipart 会话。
      while (up.pendingBytes > R2_PART_BYTES) await this.flushBlobPart(up)
      if (!final) {
        this.send(ws, encodeFrame(T.blobPut, id, JSON.stringify({ ok: true, nextOffset: up.nextOffset, done: false })))
        return
      }
      await this.finishBlobUpload(att, up)
    } catch (e: any) {
      return fail(e?.message ? String(e.message).slice(0, 200) : 'r2 upload failed')
    }
    this.blobUploads.delete(att.tid)
    this.send(ws, encodeFrame(T.blobPut, id, JSON.stringify({ ok: true, nextOffset: up.total, done: true })))
  }

  /**
   * 从攒块缓冲里切出恰好 R2_PART_BYTES 上传为一个分片。
   * R2 要求除末片外所有分片等长，所以这里必须精确切片，不能按「攒够就整块发」。
   */
  private async flushBlobPart(up: PendingUpload) {
    const bucket = this.env.BLOB!
    const all = concatBytes(up.pending, up.pendingBytes)
    const body = all.subarray(0, R2_PART_BYTES)
    const rest = all.subarray(R2_PART_BYTES)
    up.pending = rest.length ? [rest.slice()] : []
    up.pendingBytes = rest.length
    if (!up.upload) up.upload = await bucket.createMultipartUpload(this.blobKey(up.instance, up.scope, up.key))
    up.uploaded.push(await up.upload.uploadPart(up.uploaded.length + 1, body))
  }

  /** 尾片后收尾：小对象直接 put，大对象补齐末片并 complete。 */
  private async finishBlobUpload(att: TAtt, up: PendingUpload) {
    const bucket = this.env.BLOB!, sql = this.ctx.storage.sql
    const path = this.blobKey(att.instance, up.scope, up.key)
    let size = 0
    if (!up.upload) {
      const body = concatBytes(up.pending, up.pendingBytes)
      up.pending = []; up.pendingBytes = 0
      size = body.length
      await bucket.put(path, body)
    } else {
      if (up.pendingBytes > 0) {
        const body = concatBytes(up.pending, up.pendingBytes)
        up.pending = []; up.pendingBytes = 0
        up.uploaded.push(await up.upload.uploadPart(up.uploaded.length + 1, body))
      }
      await up.upload.complete(up.uploaded)
      size = up.total
    }
    sql.exec(`INSERT INTO blobs(instance,scope,k,creds,size,updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(instance,scope,k) DO UPDATE SET creds=excluded.creds,size=excluded.size,updated=excluded.updated`,
      att.instance, up.scope, up.key, up.creds, size, Date.now())
    await this.blobEvict(att.instance)
  }

  private async blobDelete(att: TAtt, r: any) {
    const bucket = this.env.BLOB
    if (!bucket || !att.reg || !att.instance || !r || !['messages', 'file'].includes(r.scope)) return
    const keys: string[] = (Array.isArray(r.keys) ? r.keys : r.key ? [r.key] : [])
      .map((x: unknown) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, 500)
    if (!keys.length) return
    await this.deleteR2Keys(bucket, keys.map(k => this.blobKey(att.instance, r.scope, k)))
    for (const k of keys) {
      this.ctx.storage.sql.exec('DELETE FROM blobs WHERE instance=? AND scope=? AND k=?', att.instance, r.scope, k)
    }
  }

  private async evictExpiredBlobs() {
    const bucket = this.env.BLOB
    if (!bucket) return
    const sql = this.ctx.storage.sql
    const rows = sql.exec('SELECT instance,scope,k FROM blobs WHERE updated<? LIMIT 100', Date.now() - BLOB_TTL).toArray()
    if (!rows.length) return
    await this.deleteR2Keys(bucket, rows.map(o => this.blobKey(String(o.instance), String(o.scope), String(o.k))))
    for (const o of rows) {
      sql.exec('DELETE FROM blobs WHERE instance=? AND scope=? AND k=?', o.instance, o.scope, o.k)
      this.blobEvicted++
    }
  }

  private async blobEvict(instance: string) {
    const bucket = this.env.BLOB!, sql = this.ctx.storage.sql
    const drop = async (rows: Record<string, any>[]) => {
      if (!rows.length) return
      await this.deleteR2Keys(bucket, rows.map(o => this.blobKey(String(o.instance), String(o.scope), String(o.k))))
      for (const o of rows) {
        sql.exec('DELETE FROM blobs WHERE instance=? AND scope=? AND k=?', o.instance, o.scope, o.k)
        this.blobEvicted++
      }
    }
    await this.evictExpiredBlobs()
    let total = Number(sql.exec('SELECT COALESCE(SUM(size),0) c FROM blobs WHERE instance=?', instance).toArray()[0]?.c ?? 0)
    while (total > MAX_BLOB_INSTANCE) {
      const old = sql.exec('SELECT instance,scope,k,size FROM blobs WHERE instance=? ORDER BY updated LIMIT 10', instance).toArray()
      if (!old.length) break
      await drop(old); total -= old.reduce((a, o) => a + Number(o.size), 0)
    }
  }

  private async blobGet(req: Request, rest: string): Promise<Response> {
    const bucket = this.env.BLOB!
    const i = rest.indexOf('/')
    const instance = (req.headers.get('x-dsh-instance') ?? '').trim()
    if (req.method !== 'GET' || i < 0 || !instance) return notFound()
    let scope: string, key: string
    try { scope = decodeURIComponent(rest.slice(0, i)); key = decodeURIComponent(rest.slice(i + 1)) } catch { return notFound() }
    if (!['messages', 'file'].includes(scope) || !key) return notFound()
    const raw = presentedCredentials(req)
    const row = this.ctx.storage.sql.exec('SELECT creds,updated FROM blobs WHERE instance=? AND scope=? AND k=?', instance, scope, key).toArray()[0]
    if (!row || !raw.length) return notFound()
    const now = Date.now()
    if (now - Number(row.updated) >= BLOB_TTL) return notFound()
    const hashes = await Promise.all(raw.map(sha256Hex))
    const creds = JSON.parse(String(row.creds)) as { hash: string; expiresAt: number }[]
    if (!creds.some(c => hashes.includes(c.hash) && (!c.expiresAt || c.expiresAt > now))) return notFound()
    const obj = await bucket.get(this.blobKey(instance, scope, key))
    if (!obj) return notFound()
    return json(200, { ok: true, scope, key, cipher: b64uEncode(new Uint8Array(await obj.arrayBuffer())), updatedAt: Number(row.updated) })
  }
}
