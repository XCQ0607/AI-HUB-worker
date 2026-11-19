import { sha256Hex } from './protocol'

export type ListKind = 'sessions' | 'workspaces'

const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_BUDGET_BYTES = 32 * 1024 * 1024
const ENTRY_IDLE_MS = 6 * 3600_000
const MAX_CREDS = 200
const REJECT_PARAMS = new Set(['fresh', 'archived', 'offset', 'limit', 'beforeSeq', 'afterSeq', 'ids', 'sessionId', 'q'])
const enc = new TextEncoder()

interface CredEntry { hash: string; expiresAt: number }

interface MirrorEntry {
  instance: string
  sessions: string
  workspaces: string
  sessionsRev: string
  workspacesRev: string
  sessionsGen: number
  workspacesGen: number
  creds: CredEntry[]
  credsStr: string
  fingerprint: string
  bytes: number
  updated: number
  lastFlushed: number
  dirty: boolean
}

export class MirrorStore {
  private mem = new Map<string, MirrorEntry>()
  private lastSweep = 0

  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS mirrors(
      instance TEXT PRIMARY KEY,
      sessions TEXT NOT NULL DEFAULT '',
      workspaces TEXT NOT NULL DEFAULT '',
      sessions_rev TEXT NOT NULL DEFAULT '',
      workspaces_rev TEXT NOT NULL DEFAULT '',
      sessions_gen INTEGER NOT NULL DEFAULT 0,
      workspaces_gen INTEGER NOT NULL DEFAULT 0,
      creds TEXT NOT NULL DEFAULT '[]',
      bytes INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0
    );`)
  }

  private loadFromSql(instanceId: string): MirrorEntry | null {
    const row = this.sql.exec('SELECT * FROM mirrors WHERE instance=?', instanceId).toArray()[0]
    if (!row) return null
    let creds: CredEntry[] = []
    const credsStr = String(row.creds || '[]')
    try { creds = JSON.parse(credsStr) } catch { creds = [] }
    const sRev = String(row.sessions_rev ?? '')
    const wRev = String(row.workspaces_rev ?? '')
    const sBody = String(row.sessions ?? '')
    const wBody = String(row.workspaces ?? '')
    const updated = Number(row.updated ?? 0)
    const entry: MirrorEntry = {
      instance: String(row.instance),
      sessions: sBody,
      workspaces: wBody,
      sessionsRev: sRev,
      workspacesRev: wRev,
      sessionsGen: Number(row.sessions_gen ?? 0),
      workspacesGen: Number(row.workspaces_gen ?? 0),
      creds,
      credsStr,
      fingerprint: `${sRev}:${wRev}:${sBody.length}:${wBody.length}:${sBody || wBody ? 1 : 0}:${credsStr}`,
      bytes: Number(row.bytes ?? 0),
      updated,
      lastFlushed: updated,
      dirty: false,
    }
    this.mem.set(instanceId, entry)
    return entry
  }

  private getEntry(instanceId: string): MirrorEntry | null {
    const key = instanceId.trim()
    if (!key) return null
    return this.mem.get(key) ?? this.loadFromSql(key)
  }

  private persist(e: MirrorEntry) {
    this.sql.exec(`INSERT INTO mirrors(instance,sessions,workspaces,sessions_rev,workspaces_rev,sessions_gen,workspaces_gen,creds,bytes,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(instance) DO UPDATE SET
        sessions=excluded.sessions, workspaces=excluded.workspaces,
        sessions_rev=excluded.sessions_rev, workspaces_rev=excluded.workspaces_rev,
        sessions_gen=excluded.sessions_gen, workspaces_gen=excluded.workspaces_gen,
        creds=excluded.creds, bytes=excluded.bytes, updated=excluded.updated`,
      e.instance, e.sessions, e.workspaces, e.sessionsRev, e.workspacesRev,
      e.sessionsGen, e.workspacesGen, e.credsStr, e.bytes, e.updated)
    e.lastFlushed = e.updated
    e.dirty = false
  }

  /** Force-flush dirty in-memory mirror entries to SQLite (e.g. on webSocketClose). */
  flush(instanceId?: string) {
    if (instanceId) {
      const e = this.mem.get(instanceId.trim())
      if (e && e.dirty) this.persist(e)
      return
    }
    for (const e of this.mem.values()) {
      if (e.dirty) this.persist(e)
    }
  }

  remember(instanceId: string, payload: any, keepBodies: boolean): boolean {
    const key = instanceId.trim()
    if (!key || !payload || payload.kind !== 'sync') return false
    const sessions = payload.sessions, workspaces = payload.workspaces
    if (sessions?.ok !== true || workspaces?.ok !== true) return false

    const creds: CredEntry[] = []
    if (Array.isArray(payload.creds)) {
      for (const item of payload.creds) {
        if (creds.length >= MAX_CREDS) break
        const rawHash = typeof item === 'string' ? item : item?.hash
        const hash = typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : ''
        if (!/^[0-9a-f]{64}$/.test(hash)) continue
        const exp = typeof item?.expiresAt === 'number' && Number.isFinite(item.expiresAt) ? Math.max(0, Math.floor(item.expiresAt)) : 0
        creds.push({ hash, expiresAt: exp })
      }
    }

    let sBody = '', wBody = ''
    if (keepBodies) {
      try {
        sBody = JSON.stringify(sessions)
        wBody = JSON.stringify(workspaces)
      } catch {
        return false
      }
      if (enc.encode(sBody).byteLength + enc.encode(wBody).byteLength > MAX_ENTRY_BYTES) return false
    }

    const sRev = typeof sessions.revision === 'string' ? sessions.revision : ''
    const wRev = typeof workspaces.revision === 'string' ? workspaces.revision : ''
    const sGen = typeof sessions.generatedAt === 'number' ? Math.floor(sessions.generatedAt) : 0
    const wGen = typeof workspaces.generatedAt === 'number' ? Math.floor(workspaces.generatedAt) : 0
    const credsStr = JSON.stringify(creds)
    const size = enc.encode(sBody).byteLength + enc.encode(wBody).byteLength + credsStr.length
    const now = Date.now()
    const fp = `${sRev}:${wRev}:${sBody.length}:${wBody.length}:${keepBodies ? 1 : 0}:${credsStr}`

    const prev = this.getEntry(key)
    const changed = !prev || prev.fingerprint !== fp
    const entry: MirrorEntry = {
      instance: key,
      sessions: sBody,
      workspaces: wBody,
      sessionsRev: sRev,
      workspacesRev: wRev,
      sessionsGen: sGen,
      workspacesGen: wGen,
      creds,
      credsStr,
      fingerprint: fp,
      bytes: size,
      updated: now,
      lastFlushed: prev?.lastFlushed ?? 0,
      dirty: changed || Boolean(prev?.dirty),
    }
    this.mem.set(key, entry)

    // Persist immediately on first seen or changed content (hibernation-safe); skip unchanged syncs until 1h keepalive.
    const keepaliveDue = now - entry.lastFlushed >= 3600_000
    if (!prev || changed || entry.dirty || keepaliveDue) {
      this.persist(entry)
      if (now - this.lastSweep >= 60_000) {
        this.lastSweep = now
        this.sweep(now)
      }
    }
    return true
  }

  private sweep(now = Date.now()) {
    for (const [k, v] of this.mem) {
      if (now - v.updated > ENTRY_IDLE_MS) this.mem.delete(k)
    }
    this.sql.exec('DELETE FROM mirrors WHERE updated < ?', now - ENTRY_IDLE_MS)
    let total = Number(this.sql.exec('SELECT COALESCE(SUM(bytes),0) c FROM mirrors').toArray()[0]?.c ?? 0)
    while (total > MAX_BUDGET_BYTES) {
      const cnt = Number(this.sql.exec('SELECT COUNT(*) c FROM mirrors').toArray()[0]?.c ?? 0)
      if (cnt <= 1) break
      const old = this.sql.exec('SELECT instance,bytes FROM mirrors ORDER BY updated ASC LIMIT 10').toArray()
      if (!old.length) break
      for (const r of old) {
        const inst = String(r.instance)
        this.mem.delete(inst)
        this.sql.exec('DELETE FROM mirrors WHERE instance=?', inst)
        total -= Number(r.bytes)
        if (total <= MAX_BUDGET_BYTES) break
      }
    }
  }

  parseRead(method: string, pathname: string, search = ''): { kind: ListKind; rev: string } | null {
    if (method.toUpperCase() !== 'GET') return null
    let kind: ListKind | null = null
    if (pathname === '/api/mobile/v1/sessions') kind = 'sessions'
    else if (pathname === '/api/mobile/v1/workspaces') kind = 'workspaces'
    else return null

    const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    for (const [k] of sp) {
      if (REJECT_PARAMS.has(k)) return null
    }
    return { kind, rev: sp.get('rev') ?? '' }
  }

  private async credsAllow(creds: CredEntry[], credentials: string[], now: number): Promise<boolean> {
    if (!credentials.length || !creds.length) return false
    for (const raw of credentials) {
      const digest = await sha256Hex(raw)
      if (creds.some(c => (c.expiresAt === 0 || c.expiresAt > now) && c.hash === digest)) return true
    }
    return false
  }

  async credentialOk(instanceId: string, credentials: string[]): Promise<boolean> {
    const e = this.getEntry(instanceId)
    if (!e) return false
    const now = Date.now()
    if (now - e.updated > ENTRY_IDLE_MS) return false
    return this.credsAllow(e.creds, credentials, now)
  }

  async lookup(instanceId: string, kind: ListKind, rev: string, credentials: string[]): Promise<string | null> {
    const e = this.getEntry(instanceId)
    if (!e) return null
    const now = Date.now()
    if (now - e.updated > ENTRY_IDLE_MS) return null
    const body = kind === 'sessions' ? e.sessions : e.workspaces
    if (!body) return null
    if (!(await this.credsAllow(e.creds, credentials, now))) return null

    const storedRev = kind === 'sessions' ? e.sessionsRev : e.workspacesRev
    const gen = kind === 'sessions' ? e.sessionsGen : e.workspacesGen
    if (rev && rev === storedRev) {
      return JSON.stringify({ ok: true, unchanged: true, revision: storedRev, generatedAt: gen, stale: true })
    }
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsed.stale = true
      return JSON.stringify(parsed)
    } catch {
      return null
    }
  }

  stats() {
    this.flush()
    this.sweep()
    const r = this.sql.exec('SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM mirrors').toArray()[0]
    return { instances: Number(r?.c ?? 0), bytes: Number(r?.b ?? 0), budget: MAX_BUDGET_BYTES }
  }

  list() {
    this.flush()
    this.sweep()
    return this.sql.exec('SELECT instance,sessions_rev,workspaces_rev,creds,bytes,updated FROM mirrors ORDER BY updated DESC LIMIT 200').toArray().map(r => {
      let credsCount = 0
      try { credsCount = JSON.parse(String(r.creds)).length } catch { /* */ }
      return {
        instance: String(r.instance),
        sessionsRev: String(r.sessions_rev),
        workspacesRev: String(r.workspaces_rev),
        credsCount,
        bytes: Number(r.bytes),
        updated: Number(r.updated),
      }
    })
  }

  clear(instanceId?: string) {
    if (instanceId) {
      this.mem.delete(instanceId.trim())
      this.sql.exec('DELETE FROM mirrors WHERE instance=?', instanceId.trim())
    } else {
      this.mem.clear()
      this.sql.exec('DELETE FROM mirrors')
    }
  }
}
