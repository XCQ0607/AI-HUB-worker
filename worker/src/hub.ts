import { DurableObject } from 'cloudflare:workers'
import { Admin, json, normClaim, type AdminEnv, type Live, type TunnelInfo } from './admin'
import { ApnsService } from './apns'
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
}

const NOT_FOUND = 'not found'
const HEALTH = '{"ok":true,"service":"dsh-mobile-relay"}'
const CHUNK = 256 * 1024
const MAX_BODY = 67 * 1024 * 1024
const MAX_PENDING = 256
const MAX_SSE_CONNECTIONS = 64
const MAX_SSE_PER_DEVICE = 3
const HEADER_TIMEOUT = 60_000
const MAX_BLOB = 5 * 1024 * 1024, MAX_BLOB_INSTANCE = 64 * 1024 * 1024, BLOB_TTL = 7 * 86400_000
const NULL_BODY = new Set([101, 204, 205, 304])
const enc = new TextEncoder()
const notFound = () => new Response(NOT_FOUND, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
const closeReason = (s: string) => enc.encode(s).length <= 123 ? s : s.slice(0, 40)

export class Hub extends DurableObject<Env> {
  private admin: Admin
  private mirror: MirrorStore
  private apns: ApnsService
  private ota: OtaStore
  private webhook: WebhookService
  private pending = new Map<number, Pend>()
  private wsState = new Map<number, { ready: boolean; queue: (string | ArrayBuffer)[] }>()
  private pluginSeen = new Map<string, { version: string; at: number }>()
  private pluginRejected = new Map<string, { version: string; min: string; at: number }>()
  private seq = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1) || 1
  private unregTimeouts = 0
  private blobEvicted = 0
  private lastSlaveReport = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.admin = new Admin(ctx.storage.sql, env)
    this.mirror = new MirrorStore(ctx.storage.sql)
    this.apns = new ApnsService(ctx.storage.sql, env)
    this.ota = new OtaStore(ctx.storage.sql, env)
    this.webhook = new WebhookService(ctx.storage.sql)
    if (this.admin.isSlave && env.PLATFORM_CLAIM_CODE?.trim()) {
      ctx.waitUntil(this.ensureAlarm(5000))
    }
  }

  // ---------- helpers ----------
  private nextId() { do { this.seq = (this.seq + 1) >>> 0 || 1 } while (this.pending.has(this.seq)); return this.seq }
  private tunnels(): { ws: WebSocket; att: TAtt }[] {
    return this.ctx.getWebSockets('tunnel').map(ws => ({ ws, att: ws.deserializeAttachment() as TAtt })).filter(x => x.att?.kind === 'tunnel')
  }
  private registered(instance: string) { return this.tunnels().filter(t => t.att.reg && t.att.instance === instance).pop() }
  private byTid(tid: string) { return this.tunnels().find(t => t.att.tid === tid) }
  private send(ws: WebSocket, frame: ArrayBuffer) { try { ws.send(frame) } catch { /* closed */ } }
  private async ensureAlarm(ms: number) {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms)
  }

  private pluginSummary() {
    const cutoff = Date.now() - 3600_000
    const min = this.admin.minVersion
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
    apns: null as unknown as ApnsService,
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
      if (bucket) {
        for (const r of rows) await bucket.delete(this.blobKey(String(r.instance), String(r.scope), String(r.k)))
      }
      if (instance) this.ctx.storage.sql.exec('DELETE FROM blobs WHERE instance=?', instance)
      else this.ctx.storage.sql.exec('DELETE FROM blobs')
    },
  }

  private getLive(): Live {
    this.live.mirror = this.mirror
    this.live.apns = this.apns
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
          apns: { enabled: this.apns.enabled(), tokens: this.apns.countTokens() },
          plugins: this.pluginSummary(),
          tunnelUnregisteredTimeouts: this.unregTimeouts,
        })
      }
      case '/api/mobile/v1/push-token': return this.handlePushToken(req)
      case '/': return notFound()
    }
    const bi = path.indexOf('/api/mobile/v1/blob/')
    if (bi >= 0 && this.env.BLOB) return this.blobGet(req, path.slice(bi + '/api/mobile/v1/blob/'.length))
    return this.forward(req, url, path)
  }

  private async handlePushToken(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
    const instance = (req.headers.get('x-dsh-instance') ?? '').trim()
    const creds = presentedCredentials(req)
    if (!creds.length) return json(401, { ok: false, error: 'device credential required' })
    if (!instance) return json(400, { ok: false, error: 'x-dsh-instance required' })
    if (!(await this.mirror.credentialOk(instance, creds))) return json(403, { ok: false, error: 'bad device credential' })
    let body: any
    try { body = await req.json() } catch { body = {} }
    const deviceId = String(body?.deviceId ?? '').trim()
    const token = String(body?.token ?? '').trim()
    const platform = String(body?.platform ?? 'ios').trim() || 'ios'
    if (!deviceId || !token) return json(400, { ok: false, error: 'deviceId and token are required' })
    this.apns.upsertToken(instance, deviceId, platform, token)
    if (body?.prefs && typeof body.prefs === 'object') {
      this.apns.upsertPrefs(instance, deviceId, JSON.stringify(body.prefs))
    }
    return json(200, { ok: true })
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
        const st = this.wsState.get(f.id)
        if (!st) return
        st.ready = true
        for (const m of st.queue.splice(0)) this.send(ws, typeof m === 'string' ? encodeFrame(T.wsText, f.id, m) : encodeFrame(T.wsBinary, f.id, new Uint8Array(m)))
        return
      }
      case T.wsError: {
        if (f.id === 0) return
        const phone = this.ctx.getWebSockets('p' + f.id)[0]
        this.wsState.delete(f.id)
        try { phone?.close(1011, closeReason(parseJson(f.payload)?.message ?? 'upstream ws error')) } catch { /* */ }
        return
      }
      case T.wsText: case T.wsBinary: {
        const phone = this.ctx.getWebSockets('p' + f.id)[0]
        if (!phone) return
        try { f.type === T.wsText ? phone.send(text(f.payload)) : phone.send(f.payload.slice().buffer) } catch { /* */ }
        return
      }
      case T.wsClose: {
        const phone = this.ctx.getWebSockets('p' + f.id)[0]
        this.wsState.delete(f.id)
        if (!phone) return
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
      case T.pushRegister: {
        if (!att.reg || !att.instance) return
        const r = parseJson(f.payload)
        const dev = String(r?.deviceId ?? '').trim()
        if (!dev) return
        if (r?.action === 'delete') this.apns.deleteDevice(att.instance, dev)
        else if (typeof r?.token === 'string' && r.token) this.apns.upsertToken(att.instance, dev, String(r.platform ?? 'ios'), r.token)
        return
      }
      case T.pushSend: {
        if (!att.reg || !att.instance) return
        const r = parseJson(f.payload)
        if (r) this.ctx.waitUntil(Promise.all([this.apns.sendCompletion(att.instance, r), this.webhook.dispatchPush(att.instance, r)]))
        return
      }
      case T.migrate: {
        if (!att.reg || !att.instance) return
        const m = parseJson(f.payload)
        this.admin.setMigration(att.instance, typeof m?.to === 'string' ? m.to.slice(0, 512) : '')
        return
      }
      case T.blobPut: await this.blobPut(att, parseJson(f.payload)); return
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
          this.dropTunnel(o.att.tid)
          try { o.ws.close(1000, 'superseded') } catch { /* */ }
        }
      }
      this.admin.touchInstance(instance, version, att.ip, license)
    }
    att.reg = true; att.instance = instance; att.version = version; att.license = license; att.saved = now
    ws.serializeAttachment(att)
    this.send(ws, jsonFrame(T.registered, 0, { ok: true, mirror: this.admin.mirrorEnabled }))
  }

  private onHead(att: TAtt, f: Frame) {
    const p = this.pending.get(f.id)
    if (!p || p.tid !== att.tid || p.headSent) return
    const h = parseJson(f.payload) ?? {}
    const status = Number(h.status) >= 200 && Number(h.status) <= 599 ? Number(h.status) : 502
    const headers = new Headers()
    for (const [k, v] of Object.entries(h.headers ?? {})) {
      if (!forwardable(k) && k.toLowerCase() !== 'content-length') continue
      try { Array.isArray(v) ? v.forEach(x => headers.append(k, String(x))) : headers.set(k, String(v)) } catch { /* bad header */ }
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
    p.resolve(new Response(stream, { status, headers }))
  }

  private finishError(id: number, p: Pend, message: string, status: number) {
    this.pending.delete(id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
    if (!p.headSent) { p.headSent = true; p.resolve(json(status, { ok: false, error: message })) }
    else try { p.ctrl?.error(new Error(message)) } catch { /* */ }
  }

  private cancel(id: number) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id); clearTimeout(p.timer ?? null); clearTimeout(p.fallbackTimer ?? null)
    const t = this.byTid(p.tid)
    if (t) this.send(t.ws, encodeFrame(T.httpCancel, id))
  }

  private dropTunnel(tid: string) {
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
    if (att?.kind === 'tunnel' && !this.admin.isSlave) {
      const remaining = this.tunnels().filter(t => t.ws !== ws)
      if (remaining.length === 0) await this.ctx.storage.deleteAlarm()
    }
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws, 1011, 'error') }

  private async reportToMaster(now: number) {
    const master = this.env.PLATFORM_MASTER_URL?.trim()
    const claim = this.env.PLATFORM_CLAIM_CODE?.trim()
    if (!master || !claim) return
    this.lastSlaveReport = now
    const sql = this.ctx.storage.sql
    const licCount = Number(sql.exec('SELECT COUNT(*) c FROM licenses').toArray()[0]?.c ?? 0)
    const devCount = Number(sql.exec("SELECT COUNT(*) c FROM license_devices WHERE status='active'").toArray()[0]?.c ?? 0)
    const online = this.tunnels().some(t => t.att.reg)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-dsh-claim': normClaim(claim),
    }
    if (this.env.PLATFORM_MASTER_TOKEN?.trim()) headers.authorization = `Bearer ${this.env.PLATFORM_MASTER_TOKEN.trim()}`
    try {
      const res = await fetch(`${master.replace(/\/+$/, '')}/api/platform/v1/nodes/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: this.env.PLATFORM_NODE_NAME || 'AI-HUB Worker',
          publicUrl: this.env.PUBLIC_BASE_URL || '',
          admissionMode: this.admin.mode,
          licenseCount: licCount,
          deviceCount: devCount,
          tunnelOnline: online,
        }),
      })
      if (!res.ok) {
        this.admin.setSetting('master_last_error', `HTTP ${res.status} ${await res.text().catch(() => '')}`)
        return
      }
      const data: any = await res.json().catch(() => ({}))
      if (data?.admissionMode === 'open' || data?.admissionMode === 'restricted') {
        this.admin.setSetting('master_manages_mode', '1')
        this.admin.setSetting('admission_mode', data.admissionMode)
      }
      this.admin.setSetting('master_last_report_at', String(now))
      this.admin.setSetting('master_last_error', '')
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

    const slaveInterval = Math.max(30, Number(this.env.PLATFORM_REPORT_INTERVAL_SECONDS) || 300) * 1000
    const isSlave = this.admin.isSlave && Boolean(this.env.PLATFORM_CLAIM_CODE?.trim())
    if (isSlave && now - this.lastSlaveReport >= slaveInterval) await this.reportToMaster(now)
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
      // Migration ledger always takes priority over offline mirror fallback.
      const to = this.admin.migration(instance)
      if (to) return json(503, { ok: false, code: 'migrated', to, error: 'that host moved to another relay' }, { 'x-dsh-migrated-to': to })
      if (mirrorRead) {
        const hit = await this.mirror.lookup(instance, mirrorRead.kind, mirrorRead.rev, presentedCredentials(req))
        if (hit) {
          this.admin.recordTraffic(instance, 1, 0, enc.encode(hit).byteLength, true)
          this.admin.flushMetrics()
          return new Response(hit, {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-relay-mirror': 'stale' },
          })
        }
      }
      const rej = this.pluginRejected.get(instance)
      if (rej && Date.now() - rej.at < 3600_000) {
        return json(503, {
          ok: false, code: 'plugin_too_old', min: rej.min, have: rej.version,
          error: `desktop plugin ${rej.version || '0.0.0'} is older than required ${rej.min}`,
        })
      }
      return json(503, { ok: false, error: 'host not connected' })
    }
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.phoneUpgrade(req, tun!, url)
    return this.forwardHttp(req, tun!, url, instance || tun!.att.instance, mirrorRead)
  }

  private cleanHeaders(req: Request, ws = false) {
    const out: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (!forwardable(k) || k.startsWith('cf-') || k.startsWith('x-aihub-') || k === 'cdn-loop' || (ws && k.startsWith('sec-websocket-'))) return
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
      if (totalSse >= MAX_SSE_CONNECTIONS) return Promise.resolve(json(429, { ok: false, error: 'too many sse connections' }))
    }
    const activeCount = tunPend.length - evicted
    if (activeCount >= MAX_PENDING) return Promise.resolve(json(429, { ok: false, error: 'too many pending requests' }))

    const id = this.nextId()
    const creds = mirrorRead ? presentedCredentials(req) : []
    const fallbackMs = mirrorRead ? this.admin.mirrorFallbackMs : 0

    return new Promise<Response>(resolve => {
      const p: Pend = { tid, method: req.method, sse: isSse, device, created: Date.now(), resolve, headSent: false, paused: false, sent: 0 }
      p.timer = setTimeout(() => {
        this.cancel(id)
        if (!p.headSent) { p.headSent = true; resolve(json(504, { ok: false, error: 'upstream header timeout' })) }
      }, HEADER_TIMEOUT)
      if (mirrorRead && fallbackMs > 0) {
        p.fallbackTimer = setTimeout(async () => {
          if (p.headSent) return
          const hit = await this.mirror.lookup(instance, mirrorRead.kind, mirrorRead.rev, creds)
          if (hit && !p.headSent) {
            this.cancel(id)
            p.headSent = true
            this.admin.recordTraffic(instance, 0, 0, enc.encode(hit).byteLength, true)
            this.admin.flushMetrics()
            resolve(new Response(hit, {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-relay-mirror': 'stale' },
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
              p.sent += value.length
              this.admin.recordTraffic(instance, 0, value.length, 0)
              if (p.sent > MAX_BODY) { this.finishError(id, p, 'request body too large', 413); this.send(tun.ws, encodeFrame(T.httpCancel, id)); return }
              for (let o = 0; o < value.length; o += CHUNK) this.send(tun.ws, encodeFrame(T.httpBody, id, value.subarray(o, o + CHUNK)))
            }
          }
          this.admin.recordTraffic(instance, 1, 0, 0)
          this.send(tun.ws, encodeFrame(T.httpBody, id))
        } catch { this.cancel(id) }
      })()
    })
  }

  private phoneUpgrade(req: Request, tun: { ws: WebSocket; att: TAtt }, url: URL): Response {
    const id = this.nextId()
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['phone', 'p' + id])
    server.serializeAttachment({ kind: 'phone', id, instance: tun.att.instance, tid: tun.att.tid } satisfies PAtt)
    this.wsState.set(id, { ready: false, queue: [] })
    this.send(tun.ws, jsonFrame(T.wsUpgrade, id, { path: routedPath(url.pathname, url.search), headers: this.cleanHeaders(req, true) }))
    setTimeout(() => { if (this.wsState.get(id)?.ready === false) { this.wsState.delete(id); try { server.close(1013, 'host did not open ws') } catch { /* */ } } }, 15_000)
    return new Response(null, { status: 101, webSocket: client })
  }

  private phoneMessage(ws: WebSocket, att: PAtt, msg: string | ArrayBuffer) {
    const t = this.byTid(att.tid)
    if (!t) { try { ws.close(1012, 'tunnel closed') } catch { /* */ } return }
    const st = this.wsState.get(att.id)
    if (st && !st.ready) { if (st.queue.length < 256) st.queue.push(msg); return }
    this.send(t.ws, typeof msg === 'string' ? encodeFrame(T.wsText, att.id, msg) : encodeFrame(T.wsBinary, att.id, new Uint8Array(msg)))
  }

  // ---------- blobs (optional R2) ----------
  private blobKey(inst: string, scope: string, key: string) { return `${inst}/${scope}/${key}` }

  private async blobPut(att: TAtt, r: any) {
    const bucket = this.env.BLOB, sql = this.ctx.storage.sql
    if (!bucket || !att.reg || !att.instance || !r) return
    const scope = r.scope, key = String(r.key ?? '')
    if (!['messages', 'file'].includes(scope) || !key || key.length > 512) return
    const parsedCreds: { hash: string; expiresAt: number }[] = []
    if (Array.isArray(r.creds)) {
      for (const c of r.creds) {
        if (parsedCreds.length >= 200) break
        const rawHash = typeof c === 'string' ? c : c?.hash
        const hash = typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : ''
        if (!/^[0-9a-f]{64}$/.test(hash)) continue
        parsedCreds.push({ hash, expiresAt: Math.max(0, Number(c?.expiresAt) || 0) })
      }
    }
    const creds = JSON.stringify(parsedCreds)
    const now = Date.now()
    if (typeof r.cipher === 'string' && r.cipher) {
      let bytes: Uint8Array
      try { bytes = b64uDecode(r.cipher) } catch { return }
      if (bytes.length > MAX_BLOB) return
      await bucket.put(this.blobKey(att.instance, scope, key), bytes)
      sql.exec(`INSERT INTO blobs(instance,scope,k,creds,size,updated) VALUES(?,?,?,?,?,?)
        ON CONFLICT(instance,scope,k) DO UPDATE SET creds=excluded.creds,size=excluded.size,updated=excluded.updated`, att.instance, scope, key, creds, bytes.length, now)
      await this.blobEvict(att.instance)
    } else {
      sql.exec('UPDATE blobs SET creds=? WHERE instance=? AND scope=? AND k=?', creds, att.instance, scope, key)
    }
  }

  private async blobDelete(att: TAtt, r: any) {
    const bucket = this.env.BLOB
    if (!bucket || !att.reg || !att.instance || !r || !['messages', 'file'].includes(r.scope)) return
    const keys: string[] = Array.isArray(r.keys) ? r.keys.map(String) : r.key ? [String(r.key)] : []
    for (const k of keys.slice(0, 500)) {
      await bucket.delete(this.blobKey(att.instance, r.scope, k))
      this.ctx.storage.sql.exec('DELETE FROM blobs WHERE instance=? AND scope=? AND k=?', att.instance, r.scope, k)
    }
  }

  private async blobEvict(instance: string) {
    const bucket = this.env.BLOB!, sql = this.ctx.storage.sql
    const drop = async (rows: Record<string, any>[]) => {
      for (const o of rows) {
        await bucket.delete(this.blobKey(String(o.instance), String(o.scope), String(o.k)))
        sql.exec('DELETE FROM blobs WHERE instance=? AND scope=? AND k=?', o.instance, o.scope, o.k)
        this.blobEvicted++
      }
    }
    await drop(sql.exec('SELECT instance,scope,k FROM blobs WHERE updated<? LIMIT 100', Date.now() - BLOB_TTL).toArray())
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
    const hashes = await Promise.all(raw.map(sha256Hex))
    const creds = JSON.parse(String(row.creds)) as { hash: string; expiresAt: number }[]
    const now = Date.now()
    if (!creds.some(c => hashes.includes(c.hash) && (!c.expiresAt || c.expiresAt > now))) return notFound()
    const obj = await bucket.get(this.blobKey(instance, scope, key))
    if (!obj) return notFound()
    return json(200, { ok: true, scope, key, cipher: b64uEncode(new Uint8Array(await obj.arrayBuffer())), updatedAt: Number(row.updated) })
  }
}
