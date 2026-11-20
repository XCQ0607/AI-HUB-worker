import { sha256Hex } from './protocol'

export type WebhookProvider = 'bark' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'discord' | 'custom'
export type WebhookEvent = 'push' | 'host.disconnect' | 'plugin.outdated' | 'auth.bruteforce'

export const WH_PROVIDERS: WebhookProvider[] = ['bark', 'telegram', 'feishu', 'dingtalk', 'wecom', 'discord', 'custom']
export const WH_EVENTS: WebhookEvent[] = ['push', 'host.disconnect', 'plugin.outdated', 'auth.bruteforce']

const enc = new TextEncoder()

function isPrivateIp4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || a >= 224
}

function isPrivateIp6(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes(':')) return false
  if (host === '::' || host === '::1') return true
  if (host.startsWith('100::')) return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') || host.startsWith('ff')) return true
  const m = /^(?:::ffff:(?:0:)?|64:ff9b:(?:1::|:)|::)([^/]+)$/.exec(host)
  if (m) {
    const tail = m[1]
    if (isPrivateIp4(tail)) return true
    const parts = tail.split(':')
    if (parts.length === 2 && /^[0-9a-f]{1,4}$/.test(parts[0]) && /^[0-9a-f]{1,4}$/.test(parts[1])) {
      const hi = parseInt(parts[0], 16), lo = parseInt(parts[1], 16)
      const ip4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
      if (isPrivateIp4(ip4)) return true
    }
  }
  return false
}

/** SSRF guard: HTTPS only, blocks credentials, private/loopback/CGNAT/link-local/ULA/multicast IPs and localhost. */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return 'URL 格式无效' }
  if (u.protocol !== 'https:') return '仅支持 HTTPS 地址'
  if (u.username || u.password) return 'URL 中不允许包含用户名或密码'
  const h = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return '不允许内网或本地域名'
  if (isPrivateIp4(h) || isPrivateIp6(h)) return '不允许私网或保留 IP 地址'
  return null
}

function redactError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"'<>]+/gi, u => {
      try { const p = new URL(u); return `${p.origin}${p.pathname.replace(/\/bot[^/]+/i, '/bot***')}` } catch { return '[url]' }
    })
    .slice(0, 300)
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function hmacB64(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
  return btoa(String.fromCharCode(...sig))
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface WebhookRow {
  id: string; name: string; provider: WebhookProvider; url: string; secret: string
  target: string; events: WebhookEvent[]; enabled: boolean; headers: Record<string, string>
  created: number; updated: number
}

export interface DispatchPayload {
  event: WebhookEvent
  title: string
  body: string
  instanceId?: string
  sessionId?: string
  kind?: string
}

export class WebhookService {
  private cooldown = new Map<string, number>()

  constructor(private sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS webhooks(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '',
        events TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        headers TEXT NOT NULL DEFAULT '{}',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        webhook_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        event TEXT NOT NULL,
        status INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created INTEGER NOT NULL
      );
    `)
  }

  private parseRow(r: Record<string, any>): WebhookRow {
    let events: WebhookEvent[] = [], headers: Record<string, string> = {}
    try { events = JSON.parse(String(r.events || '[]')) } catch { /* */ }
    try { headers = JSON.parse(String(r.headers || '{}')) } catch { /* */ }
    return {
      id: String(r.id),
      name: String(r.name),
      provider: (WH_PROVIDERS.includes(r.provider) ? r.provider : 'custom') as WebhookProvider,
      url: String(r.url),
      secret: String(r.secret ?? ''),
      target: String(r.target ?? ''),
      events,
      enabled: Boolean(r.enabled),
      headers,
      created: Number(r.created),
      updated: Number(r.updated),
    }
  }

  list(): WebhookRow[] {
    return this.sql.exec('SELECT * FROM webhooks ORDER BY created DESC LIMIT 100').toArray().map(r => this.parseRow(r))
  }

  get(id: string): WebhookRow | null {
    const r = this.sql.exec('SELECT * FROM webhooks WHERE id=?', id).toArray()[0]
    return r ? this.parseRow(r) : null
  }

  upsert(input: Partial<WebhookRow> & { id?: string; clearSecret?: boolean; requireExisting?: boolean }): { ok: boolean; id?: string; status?: number; error?: string } {
    const existing = input.id ? this.get(input.id) : null
    if (input.requireExisting && !existing) return { ok: false, status: 404, error: 'Webhook 不存在' }
    const name = String(input.name ?? '').trim().slice(0, 80)
    const provider = String(input.provider ?? 'custom') as WebhookProvider
    const url = String(input.url ?? '').trim()
    const target = String(input.target ?? '').trim().slice(0, 200)
    if (!name) return { ok: false, error: '名称不能为空' }
    if (!WH_PROVIDERS.includes(provider)) return { ok: false, error: '不支持的渠道类型' }
    if (provider === 'telegram' && !target) return { ok: false, error: 'Telegram 渠道必须填写 Chat ID' }
    const urlErr = checkWebhookUrl(url)
    if (urlErr) return { ok: false, error: urlErr }
    const events = (Array.isArray(input.events) ? input.events : ['push']).filter((e): e is WebhookEvent => WH_EVENTS.includes(e as WebhookEvent))
    const headers: Record<string, string> = {}
    if (input.headers && typeof input.headers === 'object') {
      for (const [k, v] of Object.entries(input.headers)) {
        const key = k.trim()
        if (key && !['host', 'content-length', 'content-type'].includes(key.toLowerCase())) headers[key] = String(v)
      }
    }
    const now = Date.now()
    const id = input.id || crypto.randomUUID()
    const secret = input.clearSecret ? '' : (input.secret !== undefined ? String(input.secret) : (existing?.secret ?? ''))
    this.sql.exec(`INSERT INTO webhooks(id,name,provider,url,secret,target,events,enabled,headers,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,url=excluded.url,
        secret=excluded.secret,target=excluded.target,events=excluded.events,enabled=excluded.enabled,
        headers=excluded.headers,updated=excluded.updated`,
      id, name, provider, url, secret, target,
      JSON.stringify(events), input.enabled === false ? 0 : 1, JSON.stringify(headers), existing?.created ?? now, now)
    return { ok: true, id }
  }

  batch(ids: string[], action: 'enable' | 'disable' | 'delete') {
    for (const id of ids.slice(0, 100)) {
      if (action === 'delete') this.sql.exec('DELETE FROM webhooks WHERE id=?', id)
      else this.sql.exec('UPDATE webhooks SET enabled=?,updated=? WHERE id=?', action === 'enable' ? 1 : 0, Date.now(), id)
    }
  }

  delete(id: string) {
    this.sql.exec('DELETE FROM webhooks WHERE id=?', id)
  }

  listLogs(limit = 150) {
    return this.sql.exec('SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ?', limit).toArray().map(r => ({
      id: Number(r.id),
      webhookId: String(r.webhook_id),
      webhookName: String(r.webhook_name),
      provider: String(r.provider),
      event: String(r.event),
      status: Number(r.status),
      ok: Boolean(r.ok),
      latencyMs: Number(r.latency_ms),
      error: String(r.error ?? ''),
      created: Number(r.created),
    }))
  }

  clearLogs() {
    this.sql.exec('DELETE FROM webhook_logs')
  }

  alertConfig() {
    const get = (k: string, def: string) => {
      const r = this.sql.exec('SELECT v FROM settings WHERE k=?', k).toArray()[0]
      return r ? String(r.v) : def
    }
    return {
      disconnect: get('alert_disconnect', '1') !== '0',
      bruteforce: get('alert_bruteforce', '1') !== '0',
      outdated: get('alert_outdated', '1') !== '0',
      cooldownSec: Math.max(10, Math.min(3600, Number(get('alert_cooldown_sec', '60')) || 60)),
    }
  }

  setAlertConfig(cfg: Partial<{ disconnect: boolean; bruteforce: boolean; outdated: boolean; cooldownSec: number }>) {
    const put = (k: string, v: string) => this.sql.exec('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v)
    if (cfg.disconnect !== undefined) put('alert_disconnect', cfg.disconnect ? '1' : '0')
    if (cfg.bruteforce !== undefined) put('alert_bruteforce', cfg.bruteforce ? '1' : '0')
    if (cfg.outdated !== undefined) put('alert_outdated', cfg.outdated ? '1' : '0')
    if (cfg.cooldownSec !== undefined) put('alert_cooldown_sec', String(Math.max(10, Math.min(3600, Math.floor(Number(cfg.cooldownSec) || 60)))))
  }

  private async buildRequest(w: WebhookRow, p: DispatchPayload): Promise<{ url: string; headers: Record<string, string>; body: string }> {
    const headers: Record<string, string> = { ...w.headers, 'content-type': 'application/json' }
    const tsSec = Math.floor(Date.now() / 1000)
    const tsMs = Date.now()
    const textBody = p.instanceId ? `${p.body}\n[实例: ${p.instanceId}]` : p.body

    switch (w.provider) {
      case 'bark': {
        const base = w.url.replace(/\/+$/, '')
        const targetUrl = /\/push$/i.test(base) ? base : `${base}/push`
        return {
          url: targetUrl,
          headers,
          body: JSON.stringify({ title: p.title, body: textBody, group: w.target || 'AI-HUB', sound: p.kind === 'failed' ? 'alarm' : 'bell' }),
        }
      }
      case 'telegram': {
        const msg = `<b>${escHtml(p.title)}</b>\n${escHtml(textBody)}`
        return {
          url: w.url,
          headers,
          body: JSON.stringify({
            chat_id: w.target,
            text: msg,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }
      }
      case 'feishu': {
        const template = p.event === 'push' ? (p.kind === 'failed' ? 'red' : 'green') : 'orange'
        const payload: any = {
          msg_type: 'interactive',
          card: {
            header: { template, title: { tag: 'plain_text', content: p.title } },
            elements: [{ tag: 'markdown', content: textBody }],
          },
        }
        if (w.secret) {
          payload.timestamp = String(tsSec)
          // Feishu custom bot spec: HMAC-SHA256 with key = "${timestamp}\n${secret}" and empty message.
          payload.sign = await hmacB64(`${tsSec}\n${w.secret}`, '')
        }
        return { url: w.url, headers, body: JSON.stringify(payload) }
      }
      case 'dingtalk': {
        let targetUrl = w.url
        if (w.secret) {
          const sign = encodeURIComponent(await hmacB64(w.secret, `${tsMs}\n${w.secret}`))
          targetUrl += (targetUrl.includes('?') ? '&' : '?') + `timestamp=${tsMs}&sign=${sign}`
        }
        return {
          url: targetUrl,
          headers,
          body: JSON.stringify({ msgtype: 'markdown', markdown: { title: p.title, text: `### ${p.title}\n\n${textBody}` } }),
        }
      }
      case 'wecom': {
        return {
          url: w.url,
          headers,
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content: `**${p.title}**\n${textBody}` } }),
        }
      }
      case 'discord': {
        const color = p.event === 'push' ? (p.kind === 'failed' ? 0xf87171 : 0x34d399) : 0xfbbf24
        return {
          url: w.url,
          headers,
          body: JSON.stringify({
            username: w.target || 'AI-HUB Relay',
            embeds: [{ title: p.title, description: textBody, color, timestamp: new Date().toISOString() }],
          }),
        }
      }
      default: {
        const raw = JSON.stringify({ ...p, timestamp: tsMs })
        if (w.secret) headers['x-aihub-signature'] = `sha256=${await hmacHex(w.secret, raw)}`
        return { url: w.url, headers, body: raw }
      }
    }
  }

  async sendOne(w: WebhookRow, p: DispatchPayload): Promise<{ ok: boolean; status: number; latencyMs: number; error: string }> {
    const t0 = Date.now()
    const urlErr = checkWebhookUrl(w.url)
    if (urlErr) return { ok: false, status: 0, latencyMs: 0, error: urlErr }
    let status = 0, ok = false, error = ''
    try {
      const req = await this.buildRequest(w, p)
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(7000),
      })
      status = res.status
      const txt = await res.text().catch(() => '')
      ok = res.ok
      if (ok && (w.provider === 'feishu' || w.provider === 'dingtalk' || w.provider === 'wecom')) {
        try {
          const j = JSON.parse(txt)
          const code = j.code ?? j.errcode ?? j.StatusCode ?? 0
          if (code !== 0) { ok = false; error = j.msg || j.errmsg || j.StatusMessage || txt.slice(0, 160) }
        } catch { /* non-json ok */ }
      }
      if (!ok && !error) error = txt.slice(0, 200) || `HTTP ${status}`
    } catch (e: any) {
      error = e?.message ?? String(e)
    }
    const latencyMs = Date.now() - t0
    this.sql.exec('INSERT INTO webhook_logs(webhook_id,webhook_name,provider,event,status,ok,latency_ms,error,created) VALUES(?,?,?,?,?,?,?,?,?)',
      w.id, w.name, w.provider, p.event, status, ok ? 1 : 0, latencyMs, redactError(error), Date.now())
    this.sql.exec('DELETE FROM webhook_logs WHERE id <= (SELECT id FROM webhook_logs ORDER BY id DESC LIMIT 1 OFFSET 300)')
    return { ok, status, latencyMs, error: redactError(error) }
  }

  async dispatchPush(instanceId: string, msg: any) {
    if (!msg) return
    const payload: DispatchPayload = {
      event: 'push',
      title: String(msg.title || 'AI-HUB 任务通知'),
      body: String(msg.body || ''),
      instanceId,
      sessionId: String(msg.sessionId ?? ''),
      kind: String(msg.kind ?? 'completed'),
    }
    const targets = this.list().filter(w => w.enabled && w.events.includes('push'))
    await Promise.allSettled(targets.map(w => this.sendOne(w, payload)))
  }

  async alert(event: Exclude<WebhookEvent, 'push'>, dedupKey: string, title: string, body: string, instanceId?: string) {
    const key = `${event}:${dedupKey}`
    const now = Date.now()
    const prev = this.cooldown.get(key) ?? 0
    if (now - prev < 10_000) return
    const cfg = this.alertConfig()
    if (now - prev < cfg.cooldownSec * 1000) return
    if (event === 'host.disconnect' && !cfg.disconnect) return
    if (event === 'auth.bruteforce' && !cfg.bruteforce) return
    if (event === 'plugin.outdated' && !cfg.outdated) return
    this.cooldown.set(key, now)
    if (this.cooldown.size > 500) {
      for (const [k, ts] of this.cooldown) if (now - ts > cfg.cooldownSec * 1000) this.cooldown.delete(k)
    }

    const targets = this.list().filter(w => w.enabled && w.events.includes(event))
    await Promise.allSettled(targets.map(w => this.sendOne(w, { event, title, body, instanceId })))
  }
}
