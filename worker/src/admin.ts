import { ctEq, sha256Hex } from './protocol'
import { buildOtpAuthUri, genRecoveryCodes, genTotpSecret, renderQrSvg, verifyTotpStep } from './totp'
import type { MirrorStore } from './mirror'
import type { ApnsService } from './apns'
import type { OtaStore } from './ota'
import type { WebhookService } from './webhook'

export interface AdminEnv {
  ADMIN_TOKEN?: string
  ADMISSION_MODE?: string
  MIN_PLUGIN_VERSION?: string
  MIRROR_CACHE?: string
  MIRROR_FALLBACK_MS?: string
  TUNNEL_HEARTBEAT_MS?: string
  TUNNEL_REGISTER_SECRET?: string
  PLATFORM_MASTER_URL?: string
  PLATFORM_MASTER_TOKEN?: string
  PLATFORM_CLAIM_CODE?: string
  PLATFORM_NODE_NAME?: string
  PLATFORM_OTA_CONTROL_TOKEN?: string
  PLATFORM_REPORT_INTERVAL_SECONDS?: string
  PUBLIC_BASE_URL?: string
  APNS_KEY?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
  BLOB?: R2Bucket
}

export interface TunnelInfo { id: string; version: string; ip: string; connectedAt: number; pending: number }
export interface Live {
  tunnels(): TunnelInfo[]
  kick(id: string): boolean
  mirror: MirrorStore
  apns: ApnsService
  ota: OtaStore
  webhook: WebhookService
  waitUntil(p: Promise<unknown>): void
  unregisteredTimeouts(): number
  listBlobs(): Array<{ instance: string; count: number; bytes: number; updated: number }>
  clearBlobs(instance?: string): Promise<void>
}

const API = '/api/platform/v1'
const COOKIE = 'aihub_session'
const SESSION_MS = 7 * 86400_000
const enc = new TextEncoder()

export const json = (status: number, v: unknown, h: HeadersInit = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h } })

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

async function pbkdf2(pw: string, salt: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256)))
}

export const normLicense = (c: string) => c.replace(/[—–]/g, '-').trim().toUpperCase()
const safeDec = (s: string) => { try { return decodeURIComponent(s) } catch { return null } }
const bearerToken = (req: Request) => /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim())?.[1]?.trim() ?? ''
export const normClaim = (c: string) => {
  const s = c.replace(/[—–]/g, '-').trim().toUpperCase()
  return s.startsWith('NODE-') ? s : `NODE-${s}`
}

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const seg = (n: number) => [...rand(n)].map(x => ALPHA[x % ALPHA.length]).join('')
const genCode = () => `AIHUB-${seg(4)}-${seg(4)}-${seg(4)}`
const genClaim = () => `NODE-${seg(4)}-${seg(4)}`

export class Admin {
  private tries = new Map<string, { n: number; t: number }>()
  private diagSecret = crypto.randomUUID()
  private metricBuf = { reqs: 0, bytesIn: 0, bytesOut: 0, mirrorHits: 0, lastFlush: 0 }
  private instBuf = new Map<string, { reqs: number; bytesIn: number; bytesOut: number }>()

  constructor(private sql: SqlStorage, private env: AdminEnv) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS admins(email TEXT PRIMARY KEY, salt TEXT, hash TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, email TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS licenses(id TEXT PRIMARY KEY, code TEXT UNIQUE, status TEXT DEFAULT 'active', note TEXT DEFAULT '', bound TEXT, device_limit INTEGER NOT NULL DEFAULT 1, created INTEGER, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS license_devices(id TEXT PRIMARY KEY, license_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', bound_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, UNIQUE(license_id, device_id));
      CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, version TEXT, ip TEXT, first_seen INTEGER, last_seen INTEGER, license TEXT);
      CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY, dest TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS blobs(instance TEXT, scope TEXT, k TEXT, creds TEXT, size INTEGER, updated INTEGER, PRIMARY KEY(instance, scope, k));
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, claim_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', public_url TEXT NOT NULL DEFAULT '', status_json TEXT NOT NULL DEFAULT '', admission_mode TEXT NOT NULL DEFAULT 'open', desired_mode TEXT NOT NULL DEFAULT '', license_count INTEGER NOT NULL DEFAULT 0, device_count INTEGER NOT NULL DEFAULT 0, tunnel_online INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, revoked_at INTEGER, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS metrics_hourly(hour INTEGER PRIMARY KEY, reqs INTEGER NOT NULL DEFAULT 0, bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0, mirror_hits INTEGER NOT NULL DEFAULT 0);
    `)
    try { sql.exec('ALTER TABLE licenses ADD COLUMN device_limit INTEGER NOT NULL DEFAULT 1') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE licenses ADD COLUMN expires_at INTEGER') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE admins ADD COLUMN totp_secret TEXT') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE admins ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE admins ADD COLUMN totp_recovery TEXT') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE admins ADD COLUMN totp_last_step INTEGER') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE instances ADD COLUMN req_count INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE instances ADD COLUMN bytes_in INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
    try { sql.exec('ALTER TABLE instances ADD COLUMN bytes_out INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
    // Backfill legacy single-bound licenses into license_devices once.
    const legacy = sql.exec("SELECT id,bound,created,last_used FROM licenses WHERE bound IS NOT NULL AND bound != ''").toArray()
    for (const l of legacy) {
      const exists = sql.exec('SELECT 1 FROM license_devices WHERE license_id=? AND device_id=?', l.id, l.bound).toArray()[0]
      if (!exists) {
        const ts = Number(l.last_used || l.created || Date.now())
        sql.exec('INSERT OR IGNORE INTO license_devices(id,license_id,device_id,device_name,platform,status,bound_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
          crypto.randomUUID(), l.id, l.bound, String(l.bound), 'host', 'active', ts, ts)
      }
    }
  }

  // ---- settings ----
  setting(k: string, def = ''): string {
    const r = this.sql.exec('SELECT v FROM settings WHERE k=?', k).toArray()[0]
    return r ? String(r.v) : def
  }
  setSetting(k: string, v: string) {
    this.sql.exec('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v)
  }

  get mode() { return this.setting('admission_mode', this.env.ADMISSION_MODE === 'restricted' ? 'restricted' : 'open') }
  get minVersion() { return this.setting('min_plugin_version', this.env.MIN_PLUGIN_VERSION ?? '') }
  get mirrorEnabled() { return this.setting('mirror_cache', this.env.MIRROR_CACHE === '0' ? '0' : '1') !== '0' }
  get mirrorFallbackMs() {
    const raw = Number(this.setting('mirror_fallback_ms', this.env.MIRROR_FALLBACK_MS ?? '0'))
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 30_000) : 0
  }
  get heartbeatMs() {
    const raw = Number(this.setting('heartbeat_ms', this.env.TUNNEL_HEARTBEAT_MS ?? '40000'))
    return Number.isFinite(raw) && raw >= 10_000 ? Math.min(Math.floor(raw), 60_000) : 40_000
  }
  get isSlave() { return Boolean(this.env.PLATFORM_MASTER_URL?.trim()) }
  get isModeControlled() { return this.isSlave && this.setting('master_manages_mode') === '1' }

  audit(actor: string, action: string, target = '', detail = '') {
    this.sql.exec('INSERT INTO audit_logs(actor,action,target,detail,created) VALUES(?,?,?,?,?)',
      actor, action, target.slice(0, 200), detail.slice(0, 400), Date.now())
    this.sql.exec('DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY id DESC LIMIT 500)')
  }

  private rateLimit(ip: string, bucket: string, limit: number): boolean {
    const key = `${bucket}:${ip}`, now = Date.now()
    if (this.tries.size > 1000) {
      for (const [k, v] of this.tries) if (now - v.t >= 60_000) this.tries.delete(k)
    }
    const t = this.tries.get(key)
    if (t && now - t.t < 60_000 && t.n >= limit) return false
    this.tries.set(key, { n: t && now - t.t < 60_000 ? t.n + 1 : 1, t: t && now - t.t < 60_000 ? t.t : now })
    return true
  }

  private checkLimit(ip: string, bucket: string, limit: number): boolean {
    const t = this.tries.get(`${bucket}:${ip}`)
    return !t || Date.now() - t.t >= 60_000 || t.n < limit
  }

  // ---- admission & devices ----
  admit(license: string, instance = ''): string | null {
    if (this.mode !== 'restricted') return null
    if (!license.trim()) return 'this relay requires a license code'
    const code = normLicense(license)
    const l = this.sql.exec('SELECT id,status,device_limit,expires_at FROM licenses WHERE code=?', code).toArray()[0]
    if (!l) return 'invalid license code'
    if (l.status !== 'active') return 'license revoked'
    if (l.expires_at && Number(l.expires_at) < Date.now()) return 'license expired'
    if (instance) {
      const now = Date.now()
      const existing = this.sql.exec('SELECT id,status FROM license_devices WHERE license_id=? AND device_id=?', l.id, instance).toArray()[0]
      if (existing) {
        if (existing.status !== 'active') return 'device revoked'
        this.sql.exec('UPDATE license_devices SET last_seen=? WHERE id=?', now, existing.id)
      } else {
        const cnt = Number(this.sql.exec("SELECT COUNT(*) c FROM license_devices WHERE license_id=? AND status='active'", l.id).toArray()[0]?.c ?? 0)
        const limit = Number(l.device_limit ?? 1)
        if (cnt >= limit) return 'license device limit reached'
        this.sql.exec('INSERT INTO license_devices(id,license_id,device_id,device_name,platform,status,bound_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
          crypto.randomUUID(), l.id, instance, instance, 'host', 'active', now, now)
      }
      this.sql.exec('UPDATE licenses SET bound=?, last_used=? WHERE id=?', instance, now, l.id)
    }
    return null
  }

  private bindDevice(licenseId: string, limit: number, deviceId: string, deviceName: string, platform: string) {
    const now = Date.now()
    const existing = this.sql.exec('SELECT id,status FROM license_devices WHERE license_id=? AND device_id=?', licenseId, deviceId).toArray()[0]
    if (existing) {
      this.sql.exec("UPDATE license_devices SET status='active', device_name=?, platform=?, last_seen=? WHERE id=?",
        deviceName || deviceId, platform || '', now, existing.id)
      return this.sql.exec('SELECT * FROM license_devices WHERE id=?', existing.id).toArray()[0]
    }
    const cnt = Number(this.sql.exec("SELECT COUNT(*) c FROM license_devices WHERE license_id=? AND status='active'", licenseId).toArray()[0]?.c ?? 0)
    if (cnt >= limit) return null
    const id = crypto.randomUUID()
    this.sql.exec('INSERT INTO license_devices(id,license_id,device_id,device_name,platform,status,bound_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
      id, licenseId, deviceId, deviceName || deviceId, platform || '', 'active', now, now)
    this.sql.exec('UPDATE licenses SET bound=?, last_used=? WHERE id=?', deviceId, now, licenseId)
    return this.sql.exec('SELECT * FROM license_devices WHERE id=?', id).toArray()[0]
  }

  // ---- instances / migrate ----
  touchInstance(id: string, version: string, ip: string, license: string) {
    const now = Date.now()
    this.sql.exec(`INSERT INTO instances(id,version,ip,first_seen,last_seen,license) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, ip=excluded.ip, last_seen=excluded.last_seen, license=excluded.license`,
      id, version, ip, now, now, license)
  }
  markSeen(id: string) { this.sql.exec('UPDATE instances SET last_seen=? WHERE id=?', Date.now(), id) }
  migration(id: string): string | null {
    const r = this.sql.exec('SELECT dest,expires FROM migrations WHERE id=?', id).toArray()[0]
    if (!r) return null
    if (Number(r.expires) < Date.now()) { this.sql.exec('DELETE FROM migrations WHERE id=?', id); return null }
    return String(r.dest)
  }
  setMigration(id: string, dest: string, ttlDays = 30) {
    if (!dest) this.sql.exec('DELETE FROM migrations WHERE id=?', id)
    else this.sql.exec('INSERT INTO migrations(id,dest,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET dest=excluded.dest, expires=excluded.expires', id, dest, Date.now() + ttlDays * 86400_000)
  }

  async makeDiagTicket(): Promise<string> {
    const ts = String(Date.now())
    const sig = await sha256Hex(`${this.diagSecret}:${ts}`)
    return `${ts}.${sig.slice(0, 24)}`
  }
  async verifyDiagTicket(tok: string): Promise<boolean> {
    const [ts, sig] = tok.split('.')
    if (!ts || !sig) return false
    const age = Date.now() - Number(ts)
    if (!Number.isFinite(age) || age < 0 || age > 60_000) return false
    const expected = (await sha256Hex(`${this.diagSecret}:${ts}`)).slice(0, 24)
    return ctEq(sig, expected)
  }

  // ---- auth ----
  private async createSession(email: string) {
    const token = b64(rand(32)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]!))
    this.sql.exec('INSERT INTO sessions(th,email,expires) VALUES(?,?,?)', await sha256Hex(token), email, Date.now() + SESSION_MS)
    this.sql.exec('DELETE FROM sessions WHERE expires<?', Date.now())
    return token
  }
  private async who(req: Request): Promise<string | null> {
    const bearer = bearerToken(req)
    if (this.env.ADMIN_TOKEN && bearer && ctEq(bearer, this.env.ADMIN_TOKEN)) return '(admin-token)'
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.get('cookie') ?? '')
    if (!m) return null
    const r = this.sql.exec('SELECT email,expires FROM sessions WHERE th=?', await sha256Hex(m[1])).toArray()[0]
    return r && Number(r.expires) > Date.now() ? String(r.email) : null
  }
  async isAdmin(req: Request) { return (await this.who(req)) !== null }

  async isMonitorOrAdmin(req: Request): Promise<boolean> {
    if (await this.isAdmin(req)) return true
    const url = new URL(req.url)
    const raw = bearerToken(req) || (url.searchParams.get('token') ?? '').trim()
    if (!raw) return false
    const hash = await sha256Hex(raw)
    const row = this.sql.exec('SELECT id FROM monitor_tokens WHERE token_hash=?', hash).toArray()[0]
    if (!row) return false
    this.sql.exec('UPDATE monitor_tokens SET last_used=? WHERE id=?', Date.now(), row.id)
    return true
  }

  recordTraffic(instance: string, reqs: number, bytesIn: number, bytesOut: number, mirrorHit = false) {
    this.metricBuf.reqs += reqs
    this.metricBuf.bytesIn += bytesIn
    this.metricBuf.bytesOut += bytesOut
    if (mirrorHit) this.metricBuf.mirrorHits += 1
    if (instance) {
      const cur = this.instBuf.get(instance) ?? { reqs: 0, bytesIn: 0, bytesOut: 0 }
      cur.reqs += reqs
      cur.bytesIn += bytesIn
      cur.bytesOut += bytesOut
      this.instBuf.set(instance, cur)
    }
    if (Date.now() - this.metricBuf.lastFlush >= 60_000) this.flushMetrics()
  }

  flushMetrics() {
    const now = Date.now()
    this.metricBuf.lastFlush = now
    const b = this.metricBuf
    if (b.reqs > 0 || b.bytesIn > 0 || b.bytesOut > 0 || b.mirrorHits > 0) {
      const hour = Math.floor(now / 3_600_000) * 3_600_000
      this.sql.exec(
        'INSERT INTO metrics_hourly(hour,reqs,bytes_in,bytes_out,mirror_hits) VALUES(?,?,?,?,?) ON CONFLICT(hour) DO UPDATE SET reqs=reqs+excluded.reqs, bytes_in=bytes_in+excluded.bytes_in, bytes_out=bytes_out+excluded.bytes_out, mirror_hits=mirror_hits+excluded.mirror_hits',
        hour, b.reqs, b.bytesIn, b.bytesOut, b.mirrorHits,
      )
      b.reqs = 0; b.bytesIn = 0; b.bytesOut = 0; b.mirrorHits = 0
      this.sql.exec('DELETE FROM metrics_hourly WHERE hour < ?', now - 48 * 3_600_000)
    }
    for (const [id, v] of this.instBuf) {
      this.sql.exec('UPDATE instances SET req_count=req_count+?, bytes_in=bytes_in+?, bytes_out=bytes_out+? WHERE id=?', v.reqs, v.bytesIn, v.bytesOut, id)
    }
    this.instBuf.clear()
  }

  async upsertAdmin(email: string, password: string) {
    const salt = rand(16)
    this.sql.exec('INSERT INTO admins(email,salt,hash,created) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt, hash=excluded.hash',
      email.toLowerCase(), b64(salt), await pbkdf2(password, salt), Date.now())
  }

  // ---- HTTP API ----
  async handle(req: Request, path: string, live: Live): Promise<Response> {
    const url = new URL(req.url)
    const route = path.slice(API.length)
    const method = req.method
    const body = async () => { try { return (await req.json()) as any } catch { return {} } }
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'

    if (route === '/auth/login' && method === 'POST') {
      if (!this.checkLimit(ip, 'login_fail', 10)) {
        live.waitUntil(live.webhook.alert('auth.bruteforce', ip, '登录爆破告警', `来源 IP ${ip} 登录失败次数达到限流阈值`))
        return json(429, { error: '尝试过于频繁，请稍后再试' })
      }
      const b = await body()
      const email = String(b.email ?? '').trim().toLowerCase()
      const a = this.sql.exec('SELECT salt,hash,totp_enabled,totp_secret,totp_recovery,totp_last_step FROM admins WHERE email=?', email).toArray()[0]
      const h = await pbkdf2(String(b.password ?? ''), a ? unb64(String(a.salt)) : new Uint8Array(16))
      if (!a || !ctEq(h, String(a.hash))) {
        this.rateLimit(ip, 'login_fail', 10)
        return json(401, { error: '邮箱或密码错误' })
      }
      if (Number(a.totp_enabled ?? 0) === 1 && a.totp_secret) {
        const totpCode = String(b.totpCode ?? '').trim()
        if (!totpCode) return json(200, { ok: false, totpRequired: true })
        let valid2fa = false
        const lastStep = a.totp_last_step != null ? Number(a.totp_last_step) : null
        const matchedStep = await verifyTotpStep(String(a.totp_secret), totpCode, lastStep)
        if (matchedStep !== null) {
          const upd = this.sql.exec(
            'UPDATE admins SET totp_last_step=? WHERE email=? AND (totp_last_step IS NULL OR totp_last_step < ?)',
            matchedStep, email, matchedStep,
          )
          if (upd.rowsWritten > 0) valid2fa = true
        }
        if (!valid2fa && a.totp_recovery) {
          const recHash = await sha256Hex(totpCode.toUpperCase())
          // Re-read and CAS-update synchronously with no await in between to prevent TOCTOU replay.
          const fresh = this.sql.exec('SELECT totp_recovery FROM admins WHERE email=? AND totp_enabled=1', email).toArray()[0]
          const rawCur = fresh?.totp_recovery ? String(fresh.totp_recovery) : ''
          let list: string[] = []
          try { list = JSON.parse(rawCur || '[]') } catch { list = [] }
          const idx = list.findIndex(x => ctEq(x, recHash))
          if (idx >= 0) {
            list.splice(idx, 1)
            const upd = this.sql.exec('UPDATE admins SET totp_recovery=? WHERE email=? AND totp_recovery=?', JSON.stringify(list), email, rawCur)
            if (upd.rowsWritten > 0) valid2fa = true
          }
        }
        if (!valid2fa) {
          this.rateLimit(ip, 'login_fail', 10)
          return json(401, { error: '两步验证码或恢复码错误' })
        }
      }
      this.tries.delete(`login_fail:${ip}`)
      const token = await this.createSession(email)
      const sec = url.protocol === 'https:' ? '; Secure' : ''
      this.audit(email, 'auth.login', email, ip)
      return json(200, { ok: true, email }, { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly${sec}; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` })
    }

    if (route === '/admin/bootstrap' && method === 'POST') {
      const bearer = bearerToken(req)
      if (!this.env.ADMIN_TOKEN || !bearer || !ctEq(bearer, this.env.ADMIN_TOKEN)) return json(401, { error: 'unauthorized' })
      const b = await body()
      if (!/^\S+@\S+\.\S+$/.test(String(b.email ?? '')) || String(b.password ?? '').length < 12) return json(400, { error: '邮箱无效或密码少于 12 位' })
      await this.upsertAdmin(b.email, b.password)
      this.audit('(bootstrap)', 'admin.bootstrap', String(b.email))
      return json(200, { ok: true })
    }

    if (route === '/licenses/verify' && method === 'POST') {
      if (!this.rateLimit(ip, 'lic', 60)) return json(429, { ok: false, error: 'too many requests' })
      const b = await body()
      const code = normLicense(String(b.code ?? ''))
      const deviceId = String(b.deviceId ?? '').trim()
      const l = this.sql.exec('SELECT id,status,device_limit,expires_at FROM licenses WHERE code=?', code).toArray()[0]
      if (!l || l.status !== 'active') return json(200, { ok: false, valid: false, reason: 'invalid' })
      if (l.expires_at && Number(l.expires_at) < Date.now()) return json(200, { ok: false, valid: false, reason: 'expired' })
      if (deviceId) {
        const d = this.sql.exec('SELECT id,status FROM license_devices WHERE license_id=? AND device_id=?', l.id, deviceId).toArray()[0]
        if (!d || d.status !== 'active') return json(200, { ok: false, valid: false, reason: 'device_not_bound' })
        this.sql.exec('UPDATE license_devices SET last_seen=? WHERE id=?', Date.now(), d.id)
      }
      const cnt = Number(this.sql.exec("SELECT COUNT(*) c FROM license_devices WHERE license_id=? AND status='active'", l.id).toArray()[0]?.c ?? 0)
      return json(200, { ok: true, valid: true, licenseId: l.id, deviceLimit: Number(l.device_limit ?? 1), deviceCount: cnt })
    }

    if (route === '/licenses/bind' && method === 'POST') {
      if (!this.rateLimit(ip, 'lic', 60)) return json(429, { ok: false, error: 'too many requests' })
      const b = await body()
      const code = normLicense(String(b.code ?? ''))
      const deviceId = String(b.deviceId ?? '').trim()
      const deviceName = String(b.deviceName ?? '').trim().slice(0, 120)
      const platform = String(b.platform ?? '').trim().slice(0, 32)
      if (!deviceId) return json(400, { ok: false, error: 'deviceId is required' })
      const l = this.sql.exec('SELECT id,status,device_limit,expires_at FROM licenses WHERE code=?', code).toArray()[0]
      if (!l) return json(404, { ok: false, reason: 'invalid' })
      if (l.status !== 'active') return json(403, { ok: false, reason: 'invalid' })
      if (l.expires_at && Number(l.expires_at) < Date.now()) return json(403, { ok: false, reason: 'expired' })
      const dev = this.bindDevice(String(l.id), Number(l.device_limit ?? 1), deviceId, deviceName, platform)
      if (!dev) return json(409, { ok: false, reason: 'device_limit_reached' })
      return json(200, { ok: true, device: { id: dev.id, deviceId: dev.device_id, deviceName: dev.device_name, platform: dev.platform, boundAt: dev.bound_at, lastSeenAt: dev.last_seen } })
    }

    if (route === '/nodes/report' && method === 'POST') {
      const masterTok = this.env.PLATFORM_MASTER_TOKEN?.trim()
      if (masterTok) {
        const provided = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
        if (!provided || !ctEq(provided, masterTok)) return json(401, { ok: false, error: 'bad master token' })
      }
      const claimRaw = (req.headers.get('x-dsh-claim') ?? '').trim()
      if (!claimRaw) return json(401, { ok: false, error: 'missing claim code' })
      const claim = normClaim(claimRaw)
      const node = this.sql.exec('SELECT id,revoked_at,desired_mode FROM nodes WHERE claim_code=?', claim).toArray()[0]
      if (!node) return json(404, { ok: false, error: 'unknown claim code' })
      if (node.revoked_at) return json(403, { ok: false, error: 'this node was removed by the master' })
      const b = await body()
      const now = Date.now()
      this.sql.exec(`UPDATE nodes SET name=?,public_url=?,admission_mode=?,license_count=?,device_count=?,tunnel_online=?,status_json=?,last_seen=? WHERE id=?`,
        String(b.name ?? '').slice(0, 120),
        String(b.publicUrl ?? '').slice(0, 256),
        String(b.admissionMode ?? 'open') === 'restricted' ? 'restricted' : 'open',
        Math.max(0, Number(b.licenseCount) || 0),
        Math.max(0, Number(b.deviceCount) || 0),
        b.tunnelOnline ? 1 : 0,
        typeof b.statusJson === 'string' ? b.statusJson.slice(0, 4000) : JSON.stringify(b).slice(0, 4000),
        now, node.id)
      const desired = String(node.desired_mode ?? '')
      return json(200, { ok: true, admissionMode: desired === 'open' || desired === 'restricted' ? desired : undefined })
    }

    const me = await this.who(req)
    if (!me) return json(401, { error: '未登录' })

    if (route === '/auth/me') return json(200, { email: me })
    if (route === '/auth/logout' && method === 'POST') {
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.get('cookie') ?? '')
      if (m) this.sql.exec('DELETE FROM sessions WHERE th=?', await sha256Hex(m[1]))
      return json(200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` })
    }

    if (route === '/overview') {
      const now = Date.now()
      const n = (q: string, ...p: unknown[]) => Number(this.sql.exec(q, ...p).toArray()[0]?.c ?? 0)
      const mirror = live.mirror.stats()
      return json(200, {
        colo: req.headers.get('x-aihub-colo') || 'LOCAL',
        country: req.headers.get('x-aihub-country') || '',
        role: this.isSlave ? 'slave' : 'master',
        masterUrl: this.env.PLATFORM_MASTER_URL ?? '',
        masterLastReportAt: Number(this.setting('master_last_report_at', '0')) || null,
        masterLastError: this.setting('master_last_error'),
        reportIntervalSeconds: Math.max(30, Number(this.env.PLATFORM_REPORT_INTERVAL_SECONDS) || 300),
        modeControlled: this.isModeControlled,
        mode: this.mode,
        heartbeatMs: this.heartbeatMs,
        online: live.tunnels().length,
        instances: n('SELECT COUNT(*) c FROM instances'),
        licenses: n('SELECT COUNT(*) c FROM licenses'),
        activeLicenses: n("SELECT COUNT(*) c FROM licenses WHERE status='active' AND (expires_at IS NULL OR expires_at>?)", now),
        devicesBound: n("SELECT COUNT(*) c FROM license_devices WHERE status='active'"),
        mirror: { enabled: this.mirrorEnabled, fallbackMs: this.mirrorFallbackMs, ...mirror },
        blob: { enabled: !!this.env.BLOB, count: n('SELECT COUNT(*) c FROM blobs'), bytes: n('SELECT COALESCE(SUM(size),0) c FROM blobs') },
        apns: { enabled: live.apns.enabled(), tokens: live.apns.countTokens() },
        ota: { enabled: !!this.env.BLOB, count: live.ota.count() },
        nodes: { total: n('SELECT COUNT(*) c FROM nodes WHERE revoked_at IS NULL'), online: n('SELECT COUNT(*) c FROM nodes WHERE revoked_at IS NULL AND tunnel_online=1') },
        minVersion: this.minVersion,
        migrations: n('SELECT COUNT(*) c FROM migrations WHERE expires>?', now),
        unregisteredTimeouts: live.unregisteredTimeouts(),
      })
    }

    // ---- tunnels ----
    if (route === '/tunnels') {
      const liveMap = new Map(live.tunnels().map(t => [t.id, t]))
      const rows = this.sql.exec('SELECT id,version,ip,first_seen,last_seen,license FROM instances ORDER BY last_seen DESC LIMIT 500').toArray()
      return json(200, {
        items: rows.map(r => {
          const id = String(r.id), l = liveMap.get(id)
          return {
            id, version: String(r.version ?? ''), ip: String(r.ip ?? ''),
            firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
            license: r.license ? String(r.license).slice(0, 12) + '…' : '',
            online: !!l, connectedAt: l?.connectedAt ?? null, pending: l?.pending ?? 0,
            migratedTo: this.migration(id),
          }
        }),
      })
    }
    let m = /^\/tunnels\/([^/]+)\/kick$/.exec(route)
    if (m && method === 'POST') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      const ok = live.kick(id)
      if (ok) this.audit(me, 'tunnel.kick', id)
      return json(200, { ok })
    }
    m = /^\/tunnels\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      this.sql.exec('DELETE FROM instances WHERE id=?', id)
      this.audit(me, 'instance.delete', id)
      return json(200, { ok: true })
    }

    // ---- licenses & devices ----
    if (route === '/licenses' && method === 'GET') {
      const rows = this.sql.exec(`
        SELECT l.id,l.code,l.status,l.note,l.bound,l.device_limit,l.expires_at,l.created,l.last_used,
          (SELECT COUNT(*) FROM license_devices d WHERE d.license_id=l.id AND d.status='active') AS device_count
        FROM licenses l ORDER BY l.created DESC LIMIT 1000
      `).toArray()
      return json(200, {
        items: rows.map(r => ({
          id: String(r.id), code: String(r.code), status: String(r.status), note: String(r.note ?? ''),
          bound: r.bound ? String(r.bound) : null, deviceLimit: Number(r.device_limit ?? 1),
          deviceCount: Number(r.device_count ?? 0), expiresAt: r.expires_at ? Number(r.expires_at) : null,
          created: Number(r.created), lastUsed: r.last_used ? Number(r.last_used) : null,
        })),
      })
    }
    if (route === '/licenses' && method === 'POST') {
      const b = await body()
      const count = Math.min(Math.max(Number(b.count) || 1, 1), 100)
      const limit = Math.min(Math.max(Number(b.deviceLimit) || 1, 1), 50)
      const days = Number(b.expiresInDays) || 0
      const expiresAt = days > 0 ? Date.now() + days * 86400_000 : null
      const note = String(b.note ?? '').slice(0, 200)
      const custom = b.code !== undefined ? normLicense(String(b.code)) : ''
      if (b.code !== undefined && !custom) return json(400, { error: '激活码不能为空' })
      const out: string[] = []
      for (let i = 0; i < count; i++) {
        const code = count === 1 && custom ? custom : genCode()
        try {
          this.sql.exec('INSERT INTO licenses(id,code,note,device_limit,expires_at,created) VALUES(?,?,?,?,?,?)',
            crypto.randomUUID(), code, note, limit, expiresAt, Date.now())
          out.push(code)
        } catch {
          return json(409, { error: '激活码已存在' })
        }
      }
      this.audit(me, 'license.create', out[0] ?? '', `数量 ${out.length} · 上限 ${limit}${days > 0 ? ` · ${days}天` : ''}`)
      return json(200, { ok: true, codes: out })
    }
    if (route === '/licenses/export' && method === 'GET') {
      const fmt = url.searchParams.get('format') === 'txt' ? 'txt' : 'csv'
      const rows = this.sql.exec('SELECT code,status,device_limit,expires_at,note,created FROM licenses ORDER BY created DESC LIMIT 1000').toArray()
      if (fmt === 'txt') {
        const txt = rows.map(r => `${r.code}\t${r.status}\t${r.expires_at ? new Date(Number(r.expires_at)).toISOString() : 'permanent'}\t${r.note ?? ''}`).join('\n')
        return new Response(txt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="ai-hub-licenses.txt"' } })
      }
      const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
      const csv = ['code,status,device_limit,expires_at,note,created', ...rows.map(r => [
        esc(r.code), esc(r.status), r.device_limit, esc(r.expires_at ? new Date(Number(r.expires_at)).toISOString() : 'permanent'), esc(r.note), esc(new Date(Number(r.created)).toISOString()),
      ].join(','))].join('\n')
      return new Response('\uFEFF' + csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="ai-hub-licenses.csv"' } })
    }
    if (route === '/licenses/batch' && method === 'POST') {
      const b = await body()
      const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : []
      const action = String(b.action ?? '')
      if (!['activate', 'revoke', 'unbind', 'delete', 'renew'].includes(action)) return json(400, { error: 'action 无效' })
      for (const id of ids) {
        if (action === 'delete') { this.sql.exec('DELETE FROM license_devices WHERE license_id=?', id); this.sql.exec('DELETE FROM licenses WHERE id=?', id) }
        else if (action === 'activate' || action === 'revoke') this.sql.exec('UPDATE licenses SET status=? WHERE id=?', action === 'activate' ? 'active' : 'revoked', id)
        else if (action === 'unbind') { this.sql.exec('DELETE FROM license_devices WHERE license_id=?', id); this.sql.exec('UPDATE licenses SET bound=NULL WHERE id=?', id) }
        else if (action === 'renew') {
          const days = Number(b.days)
          if (!Number.isFinite(days) || days < 0) return json(400, { error: '续期天数无效' })
          if (days === 0) this.sql.exec('UPDATE licenses SET expires_at=NULL WHERE id=?', id)
          else {
            const r = this.sql.exec('SELECT expires_at FROM licenses WHERE id=?', id).toArray()[0]
            const base = Math.max(Date.now(), Number(r?.expires_at ?? 0) || 0)
            this.sql.exec('UPDATE licenses SET expires_at=? WHERE id=?', base + days * 86400_000, id)
          }
        }
      }
      this.audit(me, `license.batch.${action}`, `${ids.length} 项`)
      return json(200, { ok: true })
    }
    m = /^\/licenses\/([^/]+)\/renew$/.exec(route)
    if (m && method === 'POST') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      const b = await body()
      const days = Number(b.days)
      if (!Number.isFinite(days) || days < 0) return json(400, { error: '续期天数无效' })
      if (days === 0) this.sql.exec('UPDATE licenses SET expires_at=NULL WHERE id=?', id)
      else {
        const r = this.sql.exec('SELECT expires_at FROM licenses WHERE id=?', id).toArray()[0]
        const base = Math.max(Date.now(), Number(r?.expires_at ?? 0) || 0)
        this.sql.exec('UPDATE licenses SET expires_at=? WHERE id=?', base + days * 86400_000, id)
      }
      this.audit(me, 'license.renew', id, days > 0 ? `+${days}d` : 'permanent')
      return json(200, { ok: true })
    }
    m = /^\/licenses\/([^/]+)\/devices\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1]), dev = safeDec(m[2])
      if (!id || !dev) return json(400, { error: '参数无效' })
      this.sql.exec('DELETE FROM license_devices WHERE license_id=? AND device_id=?', id, dev)
      const next = this.sql.exec("SELECT device_id FROM license_devices WHERE license_id=? AND status='active' ORDER BY last_seen DESC LIMIT 1", id).toArray()[0]
      this.sql.exec('UPDATE licenses SET bound=? WHERE id=?', next ? String(next.device_id) : null, id)
      this.audit(me, 'device.unbind', dev, id)
      return json(200, { ok: true })
    }
    m = /^\/licenses\/([^/]+)\/devices$/.exec(route)
    if (m && method === 'GET') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      const devs = this.sql.exec('SELECT id,device_id,device_name,platform,status,bound_at,last_seen FROM license_devices WHERE license_id=? ORDER BY last_seen DESC', id).toArray()
      return json(200, {
        items: devs.map(d => ({
          id: String(d.id), deviceId: String(d.device_id), deviceName: String(d.device_name),
          platform: String(d.platform), status: String(d.status), boundAt: Number(d.bound_at), lastSeenAt: Number(d.last_seen),
        })),
      })
    }
    m = /^\/licenses\/([^/]+)(?:\/(toggle|status|unbind))?$/.exec(route)
    if (m) {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      if (method === 'DELETE') {
        this.sql.exec('DELETE FROM license_devices WHERE license_id=?', id)
        this.sql.exec('DELETE FROM licenses WHERE id=?', id)
        this.audit(me, 'license.delete', id)
      } else if (m[2] === 'toggle' || m[2] === 'status') {
        this.sql.exec("UPDATE licenses SET status=CASE status WHEN 'active' THEN 'revoked' ELSE 'active' END WHERE id=?", id)
        this.audit(me, 'license.toggle', id)
      } else if (m[2] === 'unbind') {
        this.sql.exec('DELETE FROM license_devices WHERE license_id=?', id)
        this.sql.exec('UPDATE licenses SET bound=NULL WHERE id=?', id)
        this.audit(me, 'license.unbind', id)
      } else {
        return json(404, { error: 'not found' })
      }
      return json(200, { ok: true })
    }

    // ---- nodes federation ----
    if (route === '/nodes' && method === 'GET') {
      const rows = this.sql.exec('SELECT * FROM nodes ORDER BY created DESC LIMIT 200').toArray()
      return json(200, {
        items: rows.map(r => ({
          id: String(r.id), claimCode: String(r.claim_code), name: String(r.name), publicUrl: String(r.public_url),
          admissionMode: String(r.admission_mode), desiredMode: String(r.desired_mode),
          licenseCount: Number(r.license_count), deviceCount: Number(r.device_count),
          tunnelOnline: Boolean(r.tunnel_online), lastSeenAt: r.last_seen ? Number(r.last_seen) : null,
          revokedAt: r.revoked_at ? Number(r.revoked_at) : null, createdAt: Number(r.created),
        })),
      })
    }
    if (route === '/nodes' && method === 'POST') {
      const b = await body()
      const id = crypto.randomUUID(), code = genClaim(), name = String(b.name ?? '').slice(0, 120)
      this.sql.exec('INSERT INTO nodes(id,claim_code,name,created) VALUES(?,?,?,?)', id, code, name, Date.now())
      this.audit(me, 'node.create', code, name)
      return json(200, { ok: true, id, claimCode: code })
    }
    m = /^\/nodes\/([^/]+)\/mode$/.exec(route)
    if (m && method === 'POST') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      const b = await body()
      const mode = String(url.searchParams.get('mode') ?? b.mode ?? '').trim()
      if (!['open', 'restricted', 'auto'].includes(mode)) return json(400, { error: 'mode 必须为 open / restricted / auto' })
      const node = this.sql.exec('SELECT revoked_at FROM nodes WHERE id=?', id).toArray()[0]
      if (!node) return json(404, { error: '节点不存在' })
      if (node.revoked_at) return json(409, { error: '该节点已移除，请重新生成认领码' })
      const desired = mode === 'auto' ? '' : mode
      this.sql.exec('UPDATE nodes SET desired_mode=? WHERE id=?', desired, id)
      this.audit(me, 'node.mode', id, mode)
      return json(200, { ok: true, desiredMode: desired })
    }
    m = /^\/nodes\/([^/]+)\/forget$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      this.sql.exec('DELETE FROM nodes WHERE id=?', id)
      this.audit(me, 'node.forget', id)
      return json(200, { ok: true })
    }
    m = /^\/nodes\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      this.sql.exec('UPDATE nodes SET revoked_at=? WHERE id=?', Date.now(), id)
      this.audit(me, 'node.revoke', id)
      return json(200, { ok: true })
    }

    // ---- mirror / blobs / push / ota ----
    if (route === '/mirror' && method === 'GET') {
      return json(200, { enabled: this.mirrorEnabled, fallbackMs: this.mirrorFallbackMs, ...live.mirror.stats(), items: live.mirror.list() })
    }
    if (route === '/mirror' && method === 'DELETE') {
      live.mirror.clear(); this.audit(me, 'mirror.clear', 'all'); return json(200, { ok: true })
    }
    m = /^\/mirror\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      live.mirror.clear(id); this.audit(me, 'mirror.clear', id); return json(200, { ok: true })
    }

    if (route === '/blobs' && method === 'GET') return json(200, { enabled: !!this.env.BLOB, items: live.listBlobs() })
    if (route === '/blobs' && method === 'DELETE') { await live.clearBlobs(); this.audit(me, 'blob.clear', 'all'); return json(200, { ok: true }) }
    m = /^\/blobs\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      await live.clearBlobs(id); this.audit(me, 'blob.clear', id); return json(200, { ok: true })
    }

    if (route === '/push/tokens' && method === 'GET') {
      return json(200, { enabled: live.apns.enabled(), items: live.apns.listTokens() })
    }
    m = /^\/push\/tokens\/([^/]+)\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const inst = safeDec(m[1]), dev = safeDec(m[2])
      if (!inst || !dev) return json(400, { error: '参数无效' })
      live.apns.deleteDevice(inst, dev); this.audit(me, 'push.delete', `${inst}/${dev}`); return json(200, { ok: true })
    }
    if (route === '/push/test' && method === 'POST') {
      const b = await body()
      const inst = String(b.instance ?? '').trim()
      if (!inst) return json(400, { error: '请选择实例 ID' })
      if (!live.apns.enabled()) return json(400, { error: '未配置 APNs 密钥（APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID）' })
      const res = await live.apns.sendCompletion(inst, {
        deviceId: String(b.deviceId ?? ''),
        title: String(b.title || 'AI-HUB 推送测试'),
        body: String(b.body || '这是一条来自中转控制台的测试推送'),
        kind: 'completed',
      })
      this.audit(me, 'push.test', inst, `sent=${res.sent} failed=${res.failed}`)
      return json(200, { ok: true, ...res })
    }

    if (route === '/ota' && method === 'GET') {
      return json(200, { enabled: !!this.env.BLOB, items: live.ota.listReleases() })
    }
    if (route === '/ota/publish' && method === 'POST') {
      const res = await live.ota.handlePublish(req, url, true)
      if (res.ok) this.audit(me, 'ota.publish', `${url.searchParams.get('platform')}/${url.searchParams.get('channel')}/${url.searchParams.get('version')}`)
      return res
    }
    m = /^\/ota\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      await live.ota.deleteRelease(id); this.audit(me, 'ota.delete', id); return json(200, { ok: true })
    }

    // ---- webhooks & ops alerts ----
    if (route === '/webhooks' && method === 'GET') {
      return json(200, {
        items: live.webhook.list().map(w => ({ ...w, secret: '', secretSet: Boolean(w.secret) })),
        alerts: live.webhook.alertConfig(),
      })
    }
    if (route === '/webhooks' && method === 'POST') {
      const b = await body()
      const res = live.webhook.upsert(b)
      if (!res.ok) return json(400, { error: res.error })
      this.audit(me, 'webhook.create', String(b.name ?? ''), String(b.provider ?? 'custom'))
      return json(200, { ok: true, id: res.id })
    }
    if (route === '/webhooks/batch' && method === 'POST') {
      const b = await body()
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
      if (!['enable', 'disable', 'delete'].includes(b.action)) return json(400, { error: 'action 无效' })
      live.webhook.batch(ids, b.action)
      this.audit(me, `webhook.batch.${b.action}`, `${ids.length} 项`)
      return json(200, { ok: true })
    }
    if (route === '/webhooks/logs' && method === 'GET') return json(200, { items: live.webhook.listLogs() })
    if (route === '/webhooks/logs' && method === 'DELETE') { live.webhook.clearLogs(); this.audit(me, 'webhook.logs.clear'); return json(200, { ok: true }) }
    if (route === '/webhooks/alerts' && method === 'GET') return json(200, live.webhook.alertConfig())
    if (route === '/webhooks/alerts' && method === 'PUT') {
      const b = await body()
      live.webhook.setAlertConfig(b)
      this.audit(me, 'webhook.alerts.update')
      return json(200, { ok: true })
    }
    m = /^\/webhooks\/([^/]+)\/test$/.exec(route)
    if (m && method === 'POST') {
      const wid = safeDec(m[1])
      if (!wid) return json(400, { error: '参数无效' })
      const w = live.webhook.get(wid)
      if (!w) return json(404, { error: 'Webhook 不存在' })
      const res = await live.webhook.sendOne(w, {
        event: 'push',
        title: 'AI-HUB Webhook 测试',
        body: '这是一条来自 AI-HUB-worker 控制台的测试通知，渠道配置正常。',
        instanceId: 'test-instance',
        kind: 'completed',
      })
      this.audit(me, 'webhook.test', w.name, `ok=${res.ok} status=${res.status}`)
      return json(200, res)
    }
    m = /^\/webhooks\/([^/]+)$/.exec(route)
    if (m) {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      if (method === 'PUT') {
        const b = await body()
        const res = live.webhook.upsert({ ...b, id, requireExisting: true, clearSecret: b.clearSecret === true, secret: b.secret ? String(b.secret) : undefined })
        if (!res.ok) return json(res.status ?? 400, { error: res.error })
        this.audit(me, 'webhook.update', String(b.name ?? id))
        return json(200, { ok: true })
      }
      if (method === 'DELETE') {
        live.webhook.delete(id); this.audit(me, 'webhook.delete', id); return json(200, { ok: true })
      }
    }

    // ---- diagnostics & manual 0x1C migrations ----
    if (route === '/diagnostics' && method === 'GET') {
      return json(200, {
        colo: req.headers.get('x-aihub-colo') || 'LOCAL',
        country: req.headers.get('x-aihub-country') || '',
        mode: this.mode,
        registerSecretSet: !!this.env.TUNNEL_REGISTER_SECRET,
        wssProbeTicket: await this.makeDiagTicket(),
        serverTime: Date.now(),
      })
    }
    if (route === '/migrations' && method === 'GET') {
      const rows = this.sql.exec('SELECT id,dest,expires FROM migrations WHERE expires > ? ORDER BY expires DESC LIMIT 500', Date.now()).toArray()
      return json(200, { items: rows.map(r => ({ instanceId: String(r.id), to: String(r.dest), expiresAt: Number(r.expires) })) })
    }
    if (route === '/migrations' && method === 'POST') {
      const b = await body()
      const id = String(b.instanceId ?? '').trim().slice(0, 200)
      const to = String(b.to ?? '').trim().slice(0, 512)
      const ttlDays = Math.min(Math.max(Number(b.ttlDays) || 30, 1), 365)
      if (!id || !/^https?:\/\//i.test(to)) return json(400, { error: '请填写有效的实例 ID 与 http(s):// 目标地址' })
      this.setMigration(id, to, ttlDays)
      this.audit(me, 'migration.set', id, to)
      return json(200, { ok: true })
    }
    m = /^\/migrations\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      this.setMigration(id, '')
      this.audit(me, 'migration.delete', id)
      return json(200, { ok: true })
    }

    // ---- telemetry, monitor tokens & TOTP 2FA ----
    if (route === '/telemetry' && method === 'GET') {
      this.flushMetrics()
      const now = Date.now()
      const curHour = Math.floor(now / 3_600_000) * 3_600_000
      const startHour = curHour - 23 * 3_600_000
      const rows = this.sql.exec('SELECT hour,reqs,bytes_in,bytes_out,mirror_hits FROM metrics_hourly WHERE hour >= ? ORDER BY hour ASC', startHour).toArray()
      const byHour = new Map(rows.map(r => [Number(r.hour), r]))
      const hours = []
      for (let i = 0; i < 24; i++) {
        const h = startHour + i * 3_600_000
        const r = byHour.get(h)
        const d = new Date(h)
        hours.push({
          hour: h,
          label: `${String(d.getUTCHours()).padStart(2, '0')}:00`,
          reqs: Number(r?.reqs ?? 0),
          bytesIn: Number(r?.bytes_in ?? 0),
          bytesOut: Number(r?.bytes_out ?? 0),
          mirrorHits: Number(r?.mirror_hits ?? 0),
        })
      }
      const todayReqs = hours.reduce((acc, x) => acc + x.reqs, 0)
      const topInstances = this.sql.exec('SELECT id,version,req_count,bytes_in,bytes_out,last_seen FROM instances ORDER BY req_count DESC LIMIT 8').toArray().map(r => ({
        id: String(r.id), version: String(r.version ?? ''), reqCount: Number(r.req_count ?? 0),
        bytesIn: Number(r.bytes_in ?? 0), bytesOut: Number(r.bytes_out ?? 0), lastSeen: Number(r.last_seen ?? 0),
      }))
      const cnt = (t: string) => Number(this.sql.exec(`SELECT COUNT(*) c FROM ${t}`).toArray()[0]?.c ?? 0)
      const sqlRows = cnt('licenses') + cnt('license_devices') + cnt('instances') + cnt('blobs') + cnt('audit_logs') + cnt('nodes')
      return json(200, {
        hours,
        topInstances,
        quota: {
          dailyReqLimit: 100_000,
          todayReqs,
          sqlRows,
          activeTunnels: live.tunnels().length,
          r2Bytes: Number(this.sql.exec('SELECT COALESCE(SUM(size),0) c FROM blobs').toArray()[0]?.c ?? 0),
        },
      })
    }

    if (route === '/monitor-tokens' && method === 'GET') {
      const rows = this.sql.exec('SELECT id,name,prefix,created,last_used FROM monitor_tokens ORDER BY created DESC').toArray()
      return json(200, { items: rows.map(r => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), created: Number(r.created), lastUsed: r.last_used ? Number(r.last_used) : null })) })
    }
    if (route === '/monitor-tokens' && method === 'POST') {
      const b = await body()
      const name = String(b.name ?? '').trim().slice(0, 64) || 'Uptime Monitor'
      const raw = `ahm_${b64(rand(24)).replace(/[+/=]/g, '').slice(0, 32)}`
      const id = crypto.randomUUID()
      this.sql.exec('INSERT INTO monitor_tokens(id,name,token_hash,prefix,created) VALUES(?,?,?,?,?)',
        id, name, await sha256Hex(raw), raw.slice(0, 10) + '...', Date.now())
      this.audit(me, 'monitor.token.create', name)
      return json(200, { id, name, token: raw })
    }
    m = /^\/monitor-tokens\/([^/]+)$/.exec(route)
    if (m && method === 'DELETE') {
      const id = safeDec(m[1])
      if (!id) return json(400, { error: '参数无效' })
      this.sql.exec('DELETE FROM monitor_tokens WHERE id=?', id)
      this.audit(me, 'monitor.token.delete', id)
      return json(200, { ok: true })
    }

    if (route === '/auth/totp/status' && method === 'GET') {
      if (me === '(admin-token)') return json(200, { available: false, enabled: false, recoveryRemaining: 0 })
      const a = this.sql.exec('SELECT totp_enabled,totp_recovery FROM admins WHERE email=?', me).toArray()[0]
      let recCount = 0
      if (a?.totp_recovery) { try { recCount = JSON.parse(String(a.totp_recovery)).length } catch { recCount = 0 } }
      return json(200, { available: true, enabled: Number(a?.totp_enabled ?? 0) === 1, recoveryRemaining: recCount })
    }
    if (route === '/auth/totp/setup' && method === 'POST') {
      if (me === '(admin-token)') return json(400, { error: '请使用邮箱账号登录后再配置两步验证' })
      const a = this.sql.exec('SELECT salt,hash,totp_enabled,totp_secret,totp_recovery,totp_last_step FROM admins WHERE email=?', me).toArray()[0]
      if (!a) return json(404, { error: '账号不存在' })
      if (Number(a.totp_enabled ?? 0) === 1) {
        if (!this.checkLimit(ip, 'totp_setup', 10)) return json(429, { error: '尝试过于频繁，请稍后再试' })
        const b = await body()
        const h = await pbkdf2(String(b.password ?? ''), unb64(String(a.salt)))
        if (!ctEq(h, String(a.hash))) {
          this.rateLimit(ip, 'totp_setup', 10)
          return json(401, { error: '当前密码错误' })
        }
        const code = String(b.code ?? '').trim()
        const lastStep = a.totp_last_step != null ? Number(a.totp_last_step) : null
        let ok = a.totp_secret ? (await verifyTotpStep(String(a.totp_secret), code, lastStep)) !== null : false
        if (!ok && a.totp_recovery && code) {
          const recHash = await sha256Hex(code.toUpperCase())
          let list: string[] = []
          try { list = JSON.parse(String(a.totp_recovery)) } catch { list = [] }
          ok = list.some(x => ctEq(x, recHash))
        }
        if (!ok) {
          this.rateLimit(ip, 'totp_setup', 10)
          return json(400, { error: '当前动态验证码或恢复码不正确' })
        }
        this.tries.delete(`totp_setup:${ip}`)
      }
      const secret = genTotpSecret()
      this.sql.exec('UPDATE admins SET totp_secret=?, totp_enabled=0, totp_last_step=NULL WHERE email=?', secret, me)
      const uri = buildOtpAuthUri(me, secret, 'AI-HUB')
      return json(200, { secret, uri, qrSvg: renderQrSvg(uri) })
    }
    if (route === '/auth/totp/enable' && method === 'POST') {
      if (me === '(admin-token)') return json(400, { error: '需邮箱账号登录' })
      if (!this.checkLimit(ip, 'totp_enable', 10)) return json(429, { error: '尝试过于频繁，请稍后再试' })
      const b = await body()
      const a = this.sql.exec('SELECT totp_secret,totp_last_step FROM admins WHERE email=?', me).toArray()[0]
      if (!a?.totp_secret) return json(400, { error: '请先生成密钥' })
      const lastStep = a.totp_last_step != null ? Number(a.totp_last_step) : null
      const matchedStep = await verifyTotpStep(String(a.totp_secret), String(b.code ?? ''), lastStep)
      if (matchedStep === null) {
        this.rateLimit(ip, 'totp_enable', 10)
        return json(400, { error: '6 位动态验证码不正确' })
      }
      this.tries.delete(`totp_enable:${ip}`)
      const recoveryCodes = genRecoveryCodes(8)
      const hashes = await Promise.all(recoveryCodes.map(c => sha256Hex(c)))
      this.sql.exec('UPDATE admins SET totp_enabled=1, totp_recovery=?, totp_last_step=? WHERE email=?', JSON.stringify(hashes), matchedStep, me)
      this.audit(me, 'auth.totp.enable', me)
      return json(200, { ok: true, recoveryCodes })
    }
    if (route === '/auth/totp/disable' && method === 'POST') {
      if (me === '(admin-token)') return json(400, { error: '需邮箱账号登录' })
      if (!this.checkLimit(ip, 'totp_disable', 10)) return json(429, { error: '尝试过于频繁，请稍后再试' })
      const b = await body()
      const a = this.sql.exec('SELECT salt,hash,totp_secret,totp_recovery,totp_last_step FROM admins WHERE email=?', me).toArray()[0]
      if (!a) return json(404, { error: '账号不存在' })
      const h = await pbkdf2(String(b.password ?? ''), unb64(String(a.salt)))
      if (!ctEq(h, String(a.hash))) {
        this.rateLimit(ip, 'totp_disable', 10)
        return json(401, { error: '当前密码错误' })
      }
      if (a.totp_secret) {
        const code = String(b.code ?? '').trim()
        const lastStep = a.totp_last_step != null ? Number(a.totp_last_step) : null
        let ok = (await verifyTotpStep(String(a.totp_secret), code, lastStep)) !== null
        if (!ok && a.totp_recovery && code) {
          const recHash = await sha256Hex(code.toUpperCase())
          let list: string[] = []
          try { list = JSON.parse(String(a.totp_recovery)) } catch { list = [] }
          ok = list.some(x => ctEq(x, recHash))
        }
        if (!ok) {
          this.rateLimit(ip, 'totp_disable', 10)
          return json(400, { error: '动态验证码或恢复码不正确' })
        }
      }
      this.tries.delete(`totp_disable:${ip}`)
      this.sql.exec('UPDATE admins SET totp_enabled=0, totp_secret=NULL, totp_recovery=NULL, totp_last_step=NULL WHERE email=?', me)
      this.audit(me, 'auth.totp.disable', me)
      return json(200, { ok: true })
    }

    // ---- settings & audit ----
    if (route === '/settings' && method === 'GET') {
      return json(200, {
        colo: req.headers.get('x-aihub-colo') || 'LOCAL',
        mode: this.mode,
        minVersion: this.minVersion,
        mirrorEnabled: this.mirrorEnabled,
        mirrorFallbackMs: this.mirrorFallbackMs,
        heartbeatMs: this.heartbeatMs,
        registerSecretSet: !!this.env.TUNNEL_REGISTER_SECRET,
        apnsEnabled: live.apns.enabled(),
        r2Enabled: !!this.env.BLOB,
        otaTokenSet: !!this.env.PLATFORM_OTA_CONTROL_TOKEN,
        role: this.isSlave ? 'slave' : 'master',
        masterUrl: this.env.PLATFORM_MASTER_URL ?? '',
        modeControlled: this.isModeControlled,
      })
    }
    if (route === '/settings' && method === 'PUT') {
      const b = await body()
      if (b.mode !== undefined) {
        if (this.isModeControlled) return json(409, { error: '当前由主控端接管准入模式，无法本地修改' })
        if (!['open', 'restricted'].includes(b.mode)) return json(400, { error: 'mode 无效' })
        this.setSetting('admission_mode', b.mode); this.audit(me, 'settings.mode', b.mode)
      }
      if (b.minVersion !== undefined) {
        if (b.minVersion && !/^v?\d+\.\d+\.\d+$/.test(b.minVersion)) return json(400, { error: '版本格式应为 x.y.z' })
        this.setSetting('min_plugin_version', b.minVersion); this.audit(me, 'settings.minVersion', b.minVersion || '(unlimited)')
      }
      if (b.mirrorEnabled !== undefined) {
        const v = b.mirrorEnabled ? '1' : '0'
        this.setSetting('mirror_cache', v); this.audit(me, 'settings.mirror', v)
      }
      if (b.mirrorFallbackMs !== undefined) {
        const ms = Math.max(0, Math.min(30_000, Math.floor(Number(b.mirrorFallbackMs) || 0)))
        this.setSetting('mirror_fallback_ms', String(ms)); this.audit(me, 'settings.mirrorFallbackMs', String(ms))
      }
      if (b.heartbeatMs !== undefined) {
        const ms = Math.max(10_000, Math.min(60_000, Math.floor(Number(b.heartbeatMs) || 40_000)))
        this.setSetting('heartbeat_ms', String(ms)); this.audit(me, 'settings.heartbeatMs', String(ms))
      }
      return json(200, { ok: true })
    }
    if (route === '/audit' && method === 'GET') {
      const action = (url.searchParams.get('action') ?? '').trim()
      const rows = action
        ? this.sql.exec('SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY id DESC LIMIT 200', `%${action}%`).toArray()
        : this.sql.exec('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').toArray()
      return json(200, {
        items: rows.map(r => ({
          id: Number(r.id), actor: String(r.actor), action: String(r.action),
          target: String(r.target), detail: String(r.detail), created: Number(r.created),
        })),
      })
    }
    if (route === '/admin/password' && method === 'POST') {
      const b = await body()
      if (me === '(admin-token)' || String(b.password ?? '').length < 12) return json(400, { error: '需用账号登录且新密码至少 12 位' })
      await this.upsertAdmin(me, b.password)
      this.sql.exec('DELETE FROM sessions WHERE email=?', me)
      this.audit(me, 'admin.password', me)
      return json(200, { ok: true })
    }
    return json(404, { error: 'not found' })
  }
}
