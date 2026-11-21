import { b64uEncode } from './protocol'

export interface ApnsEnv {
  APNS_KEY?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
}

const APNS_URL = 'https://api.push.apple.com/3/device'
const PAYLOAD_BUDGET = 3800
const enc = new TextEncoder()

type Level = 'normal' | 'silent' | 'off'

const PREF_KEY: Record<string, string> = {
  completed: 'done',
  failed: 'failed',
  approval: 'approval',
  question: 'question',
  'plan-review': 'planReview',
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/\\n/g, '\n').split(/\r?\n/).filter(l => !l.startsWith('-----') && l.trim()).join('')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function deviceLevel(prefsJson: string | undefined, kind: string, sessionId: string): Level {
  if (!prefsJson) return 'normal'
  let prefs: any
  try { prefs = JSON.parse(prefsJson) } catch { return 'normal' }
  if (sessionId && Array.isArray(prefs?.muted)) {
    const suffix = `:${sessionId}`
    if (prefs.muted.some((x: unknown) => typeof x === 'string' && x.endsWith(suffix))) return 'off'
  }
  const key = PREF_KEY[kind]
  if (!key) return 'normal'
  const v = prefs?.levels?.[key]
  if (v === 'off') return 'off'
  if (v === 'silent') return 'silent'
  return 'normal'
}

function fitPayload(payload: any) {
  const size = () => enc.encode(JSON.stringify(payload)).byteLength
  if (size() <= PAYLOAD_BUDGET) return
  delete payload.dshInteraction
  if (size() <= PAYLOAD_BUDGET) return
  delete payload.aps.category
  if (size() <= PAYLOAD_BUDGET) return
  for (const field of ['body', 'title'] as const) {
    while (size() > PAYLOAD_BUDGET) {
      const s = String(payload.aps.alert[field] ?? '')
      if (!s) break
      const chars = [...s]
      const keep = Math.floor((chars.length * 3) / 4)
      payload.aps.alert[field] = chars.slice(0, keep).join('')
      if (!keep) break
    }
    if (size() <= PAYLOAD_BUDGET) break
  }
}

export class ApnsService {
  private signingKey?: Promise<CryptoKey>
  private cachedJwt?: { token: string; exp: number }

  constructor(private sql: SqlStorage, private env: ApnsEnv) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS push_tokens(
        instance TEXT NOT NULL, device_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'ios',
        token TEXT NOT NULL, updated INTEGER NOT NULL,
        PRIMARY KEY(instance, device_id)
      );
      CREATE TABLE IF NOT EXISTS push_prefs(
        instance TEXT NOT NULL, device_id TEXT NOT NULL, prefs TEXT NOT NULL, updated INTEGER NOT NULL,
        PRIMARY KEY(instance, device_id)
      );
    `)
  }

  enabled(): boolean {
    return Boolean(this.env.APNS_KEY?.trim() && this.env.APNS_KEY_ID?.trim() && this.env.APNS_TEAM_ID?.trim() && this.env.APNS_TOPIC?.trim())
  }

  private async getKey(): Promise<CryptoKey> {
    if (!this.signingKey) {
      const p = (async () => {
        const der = pemToDer(this.env.APNS_KEY!.trim())
        return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
      })()
      this.signingKey = p.catch(err => {
        if (this.signingKey === p) this.signingKey = undefined
        throw err
      })
    }
    return this.signingKey
  }

  private async providerJwt(): Promise<string> {
    const now = Date.now()
    if (this.cachedJwt && now < this.cachedJwt.exp) return this.cachedJwt.token
    const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'ES256', kid: this.env.APNS_KEY_ID!.trim() })))
    const claims = b64uEncode(enc.encode(JSON.stringify({ iss: this.env.APNS_TEAM_ID!.trim(), iat: Math.floor(now / 1000) })))
    const input = `${header}.${claims}`
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.getKey(), enc.encode(input)))
    const token = `${input}.${b64uEncode(sig)}`
    this.cachedJwt = { token, exp: now + 45 * 60_000 }
    return token
  }

  upsertToken(instance: string, deviceId: string, platform: string, token: string) {
    this.sql.exec(`INSERT INTO push_tokens(instance,device_id,platform,token,updated) VALUES(?,?,?,?,?)
      ON CONFLICT(instance,device_id) DO UPDATE SET platform=excluded.platform,token=excluded.token,updated=excluded.updated`,
      instance, deviceId, platform || 'ios', token, Date.now())
  }

  upsertPrefs(instance: string, deviceId: string, prefs: string) {
    this.sql.exec(`INSERT INTO push_prefs(instance,device_id,prefs,updated) VALUES(?,?,?,?)
      ON CONFLICT(instance,device_id) DO UPDATE SET prefs=excluded.prefs,updated=excluded.updated`,
      instance, deviceId, prefs, Date.now())
  }

  deleteDevice(instance: string, deviceId: string) {
    this.sql.exec('DELETE FROM push_tokens WHERE instance=? AND device_id=?', instance, deviceId)
    this.sql.exec('DELETE FROM push_prefs WHERE instance=? AND device_id=?', instance, deviceId)
  }

  countTokens(): number {
    return Number(this.sql.exec('SELECT COUNT(*) c FROM push_tokens').toArray()[0]?.c ?? 0)
  }

  listTokens() {
    return this.sql.exec('SELECT instance,device_id,platform,token,updated FROM push_tokens ORDER BY updated DESC LIMIT 500').toArray().map(r => {
      const tok = String(r.token)
      return {
        instance: String(r.instance),
        deviceId: String(r.device_id),
        platform: String(r.platform),
        tokenPreview: tok.length > 16 ? `${tok.slice(0, 8)}…${tok.slice(-6)}` : tok,
        updated: Number(r.updated),
      }
    })
  }

  private async sendOne(token: string, payload: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const jwt = await this.providerJwt()
      const headers: Record<string, string> = {
        authorization: `bearer ${jwt}`,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      }
      if (this.env.APNS_TOPIC?.trim()) headers['apns-topic'] = this.env.APNS_TOPIC.trim()
      const res = await fetch(`${APNS_URL}/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      if (res.ok) return { ok: true, status: res.status }
      return { ok: false, status: res.status, error: `APNs ${res.status}: ${await res.text().catch(() => '')}` }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  async sendCompletion(instanceId: string, msg: any): Promise<{ sent: number; failed: number; errors: string[] }> {
    if (!this.enabled() || !instanceId || !msg) return { sent: 0, failed: 0, errors: [] }
    const deviceId = String(msg.deviceId ?? '').trim()
    const title = String(msg.title ?? '').trim()
    if (!title) return { sent: 0, failed: 0, errors: [] }
    const body = String(msg.body ?? '')
    const sessionId = String(msg.sessionId ?? '')
    const category = String(msg.category ?? '')
    const kind = String(msg.pushKind || msg.kind || '')
    const interaction = msg.interaction && typeof msg.interaction === 'object' ? msg.interaction : undefined

    const tokens = this.sql.exec('SELECT device_id,token FROM push_tokens WHERE instance=?', instanceId).toArray()
    const prefsRows = this.sql.exec('SELECT device_id,prefs FROM push_prefs WHERE instance=?', instanceId).toArray()
    const prefsMap = new Map(prefsRows.map(p => [String(p.device_id), String(p.prefs)]))

    let sent = 0, failed = 0
    const errors: string[] = []
    for (const row of tokens) {
      const dev = String(row.device_id)
      if (deviceId && dev !== deviceId) continue
      const level = deviceLevel(prefsMap.get(dev), kind, sessionId)
      if (level === 'off') continue
      const aps: Record<string, unknown> = { alert: { title, body } }
      if (level === 'normal') aps.sound = 'default'
      else aps['interruption-level'] = 'passive'
      if (category) aps.category = category
      const payload: any = { aps, sessionId, instanceId }
      if (interaction) payload.dshInteraction = interaction
      fitPayload(payload)
      const res = await this.sendOne(String(row.token), payload)
      if (res.ok) sent++
      else {
        if (res.status === 410) this.deleteDevice(instanceId, dev)
        failed++
        if (res.error) errors.push(res.error)
      }
    }
    return { sent, failed, errors }
  }
}
