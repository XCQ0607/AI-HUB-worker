import { ctEq, sha256Hex } from './protocol'

export interface OtaEnv {
  BLOB?: R2Bucket
  PLATFORM_OTA_CONTROL_TOKEN?: string
  PUBLIC_BASE_URL?: string
}

const MAX_OTA_BYTES = 32 * 1024 * 1024
const json = (status: number, v: unknown) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const validVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v)
const safeSeg = (s: string) => /^[a-zA-Z0-9_-]{1,32}$/.test(s)

export class OtaStore {
  constructor(private sql: SqlStorage, private env: OtaEnv) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ota_releases(
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      version TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      created INTEGER NOT NULL,
      UNIQUE(platform, channel, version)
    );`)
  }

  count(): number {
    return Number(this.sql.exec('SELECT COUNT(*) c FROM ota_releases').toArray()[0]?.c ?? 0)
  }

  listReleases() {
    return this.sql.exec('SELECT id,platform,channel,version,size,sha256,created FROM ota_releases ORDER BY created DESC LIMIT 200').toArray().map(r => ({
      id: String(r.id),
      platform: String(r.platform),
      channel: String(r.channel),
      version: String(r.version),
      size: Number(r.size),
      sha256: String(r.sha256),
      created: Number(r.created),
    }))
  }

  async deleteRelease(id: string): Promise<boolean> {
    const row = this.sql.exec('SELECT r2_key FROM ota_releases WHERE id=?', id).toArray()[0]
    if (!row) return false
    if (this.env.BLOB) await this.env.BLOB.delete(String(row.r2_key))
    this.sql.exec('DELETE FROM ota_releases WHERE id=?', id)
    return true
  }

  handleLatest(req: Request, url: URL): Response {
    const platform = (url.searchParams.get('platform') ?? '').trim()
    const channel = (url.searchParams.get('channel') ?? 'stable').trim() || 'stable'
    if (!platform) return json(400, { ok: false, error: 'platform is required' })
    const row = this.sql.exec(
      'SELECT version,platform,channel,size,sha256 FROM ota_releases WHERE platform=? AND channel=? ORDER BY created DESC LIMIT 1',
      platform, channel,
    ).toArray()[0]
    if (!row) return json(200, { ok: false, reason: 'no release' })
    const base = (this.env.PUBLIC_BASE_URL?.trim() || url.origin).replace(/\/+$/, '')
    return json(200, {
      ok: true,
      data: {
        version: String(row.version),
        platform: String(row.platform),
        channel: String(row.channel),
        packageUrl: `${base}/api/desktop-plugins/ota/download/${row.platform}/${row.channel}/${row.version}`,
        size: Number(row.size),
        sha256: String(row.sha256),
      },
    })
  }

  async handleDownload(rest: string): Promise<Response> {
    const clean = rest.replace(/\.tar\.gz$/, '')
    const parts = clean.split('/')
    if (parts.length !== 3) return new Response('not found\n', { status: 404 })
    const [platform, channel, version] = parts
    if (!safeSeg(platform) || !safeSeg(channel) || !validVersion(version)) return new Response('not found\n', { status: 404 })
    const row = this.sql.exec('SELECT r2_key FROM ota_releases WHERE platform=? AND channel=? AND version=?', platform, channel, version).toArray()[0]
    if (!row || !this.env.BLOB) return new Response('not found\n', { status: 404 })
    const obj = await this.env.BLOB.get(String(row.r2_key))
    if (!obj) return new Response('package missing in R2\n', { status: 404 })
    return new Response(obj.body, {
      status: 200,
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="dsh-plugin-${platform}-${channel}-${version}.tar.gz"`,
      },
    })
  }

  authorizePublish(req: Request, isAdmin: boolean): Response | null {
    if (isAdmin) return null
    const tok = this.env.PLATFORM_OTA_CONTROL_TOKEN?.trim()
    if (!tok) return json(403, { ok: false, error: 'publishing is disabled (PLATFORM_OTA_CONTROL_TOKEN unset)' })
    const provided = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!provided || !ctEq(provided, tok)) return json(401, { ok: false, error: 'bad control token' })
    return null
  }

  async handlePublish(req: Request, url: URL, isAdmin: boolean): Promise<Response> {
    const authErr = this.authorizePublish(req, isAdmin)
    if (authErr) return authErr
    if (!this.env.BLOB) return json(503, { ok: false, error: '未绑定 R2 存储桶 (BLOB)，无法存储 OTA 包' })
    const platform = (url.searchParams.get('platform') ?? '').trim()
    const channel = (url.searchParams.get('channel') ?? 'stable').trim() || 'stable'
    const version = (url.searchParams.get('version') ?? '').trim()
    if (!safeSeg(platform) || !safeSeg(channel) || !validVersion(version)) {
      return json(400, { ok: false, error: 'platform / channel / version (X.Y.Z) are required' })
    }
    const lenHdr = Number(req.headers.get('content-length') ?? 0)
    if (lenHdr > MAX_OTA_BYTES) return json(413, { ok: false, error: 'package too large' })

    const buf = new Uint8Array(await req.arrayBuffer())
    if (!buf.byteLength) return json(400, { ok: false, error: 'empty package' })
    if (buf.byteLength > MAX_OTA_BYTES) return json(413, { ok: false, error: 'package too large' })
    if (buf.byteLength < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      return json(400, { ok: false, error: 'body must be a gzip tarball (.tar.gz)' })
    }

    const r2Key = `ota/${platform}/${channel}/${version}.tar.gz`
    await this.env.BLOB.put(r2Key, buf, { httpMetadata: { contentType: 'application/gzip' } })
    const sha256 = await sha256Hex(buf)
    const now = Date.now()
    this.sql.exec(`INSERT INTO ota_releases(id,platform,channel,version,size,sha256,r2_key,created) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,channel,version) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,r2_key=excluded.r2_key,created=excluded.created`,
      crypto.randomUUID(), platform, channel, version, buf.byteLength, sha256, r2Key, now)
    return json(200, { ok: true, data: { platform, channel, version, size: buf.byteLength, sha256 } })
  }

  async handle(req: Request, url: URL, rest: string, isAdmin: boolean): Promise<Response | null> {
    if (req.method === 'GET' && rest === 'latest') return this.handleLatest(req, url)
    if (req.method === 'POST' && rest === 'publish') return this.handlePublish(req, url, isAdmin)
    if (req.method === 'GET' && rest.startsWith('download/')) return this.handleDownload(rest.slice('download/'.length))
    return null
  }
}
