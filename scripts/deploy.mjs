#!/usr/bin/env node
// One-command deploy:  node scripts/deploy.mjs
// Auth (first match wins): CLOUDFLARE_API_TOKEN | CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY | existing `wrangler login` session.
// Config comes from env.json (gitignored); real environment variables take priority.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseJsonc(str) {
  const src = String(str).replace(/^\uFEFF/, '')
  let noComments = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      noComments += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      noComments += ch
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      if (i < src.length) noComments += '\n'
    } else if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
    } else {
      noComments += ch
    }
  }
  let out = ''
  inStr = false
  esc = false
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
    } else if (ch === ',') {
      let j = i + 1
      while (j < noComments.length && /\s/.test(noComments[j])) j++
      if (noComments[j] === '}' || noComments[j] === ']') continue
      out += ch
    } else {
      out += ch
    }
  }
  return JSON.parse(out)
}

export async function main() {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..')
  const worker = join(base, 'worker'), web = join(base, 'web')
  const env = { ...process.env }
  const envFile = join(base, 'env.json')
  if (existsSync(envFile)) {
    for (const [k, v] of Object.entries(parseJsonc(readFileSync(envFile, 'utf8')))) {
      if (!k.startsWith('_') && v !== '' && v != null && !env[k]) env[k] = String(v)
    }
    console.log('Loaded config from env.json')
  }
  const name = env.WORKER_NAME || 'ai-hub-relay'
  const sh = process.platform === 'win32'

  function run(cmd, args, { cwd = worker, input, allowFail, retries = 1 } = {}) {
    let r
    for (let i = 0; i < retries; i++) {
      r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: sh, input })
      if (r.status === 0) return r
    }
    if (!allowFail) { console.error(r.stdout, r.stderr); throw new Error(`${cmd} ${args.join(' ')} failed`) }
    return r
  }
  const step = (n, t) => console.log(`\n[${n}/6] ${t}`)

  let headers = null
  if (env.CLOUDFLARE_API_TOKEN) headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
  else if (env.CLOUDFLARE_EMAIL && env.CLOUDFLARE_API_KEY) headers = { 'X-Auth-Email': env.CLOUDFLARE_EMAIL, 'X-Auth-Key': env.CLOUDFLARE_API_KEY }
  console.log('Auth mode:', env.CLOUDFLARE_API_TOKEN ? 'API Token' : headers ? 'Global API Key' : 'wrangler OAuth')
  // wrangler reads CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY itself; clear stale email when API key is empty so OAuth works cleanly.
  if (!env.CLOUDFLARE_API_KEY) delete env.CLOUDFLARE_EMAIL
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_API_KEY']) if (!env[k]) delete env[k]

  async function cf(path, h = headers) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { 'Content-Type': 'application/json', ...h } })
    const j = await res.json()
    if (!j.success) throw new Error(`${path}: ${j.errors?.map(e => e.message).join('; ')}`)
    return j.result
  }
  function oauthHeaders() {
    const r = run('npx', ['wrangler', 'auth', 'token'], { allowFail: true })
    const tok = (r.stdout || '').trim().split(/\r?\n/).pop()?.trim()
    return tok && tok.length > 20 ? { Authorization: `Bearer ${tok}` } : null
  }
  const npmInstallArgs = dir => [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund']

  step(1, 'install dependencies & build admin console')
  run('npm', npmInstallArgs(worker), { cwd: worker, retries: 2 })
  if (existsSync(join(web, 'package.json'))) {
    run('npm', npmInstallArgs(web), { cwd: web, retries: 2 }); run('npm', ['run', 'build'], { cwd: web })
  } else if (!existsSync(join(worker, 'public', 'platform', 'index.html'))) throw new Error('web/ missing and worker/public not built')

  step(2, 'resolve Cloudflare account')
  let acct = env.CLOUDFLARE_ACCOUNT_ID
  if (!acct) {
    try {
      const list = await cf('/accounts', headers ?? oauthHeaders() ?? {})
      if (list.length === 1) acct = list[0].id
      else throw new Error(`found ${list.length} accounts: ${list.map(a => `${a.name}=${a.id}`).join(', ')}`)
    } catch (e) { console.log(`  cannot auto-detect account (${e.message}); set CLOUDFLARE_ACCOUNT_ID if wrangler complains`) }
  }
  if (acct) { env.CLOUDFLARE_ACCOUNT_ID = acct; console.log('  account', acct) }

  step(3, 'R2 bucket (optional, for history blobs)')
  const cfg = parseJsonc(readFileSync(join(worker, 'wrangler.jsonc'), 'utf8'))
  cfg.name = name
  cfg.vars = {
    ...cfg.vars,
    ADMISSION_MODE: env.ADMISSION_MODE || 'open',
    MIN_PLUGIN_VERSION: env.MIN_PLUGIN_VERSION || '',
    MIRROR_CACHE: env.MIRROR_CACHE === '0' ? '0' : '1',
    MIRROR_FALLBACK_MS: env.MIRROR_FALLBACK_MS || '0',
  }
  for (const k of [
    'DO_LOCATION',
    'TUNNEL_HEARTBEAT_MS',
    'PLATFORM_MASTER_URL',
    'PLATFORM_CLAIM_CODE',
    'PLATFORM_NODE_NAME',
    'PLATFORM_REPORT_INTERVAL_SECONDS',
    'PUBLIC_BASE_URL',
  ]) {
    if (env[k]) cfg.vars[k] = env[k]
  }
  let r2 = 'disabled'
  if (env.ENABLE_R2 !== '0') {
    const bucket = env.R2_BUCKET || 'ai-hub-blob'
    const r = run('npx', ['wrangler', 'r2', 'bucket', 'create', bucket], { allowFail: true })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status === 0 || /already exists/i.test(out)) { cfg.r2_buckets = [{ binding: 'BLOB', bucket_name: bucket }]; r2 = bucket }
    else console.log('  R2 unavailable (not enabled on this account?) -> blobs disabled.', out.split('\n').find(l => /error/i.test(l)) ?? '')
  }
  const genFile = join(worker, 'wrangler.generated.json')
  writeFileSync(genFile, JSON.stringify(cfg, null, 2))

  step(4, 'deploy worker')
  const dep = run('npx', ['wrangler', 'deploy', '-c', 'wrangler.generated.json'], { retries: 3 })
  const url = /https:\/\/[^\s]+workers\.dev/.exec(dep.stdout + dep.stderr)?.[0]
  console.log('  ', url ?? '(workers.dev URL not detected)')

  step(5, 'secrets')
  const listed = run('npx', ['wrangler', 'secret', 'list', '-c', 'wrangler.generated.json', '--format', 'json'], { allowFail: true })
  const existing = new Set((() => { try { return JSON.parse(listed.stdout).map(s => s.name) } catch { return [] } })())
  const secrets = {}
  let adminToken = env.ADMIN_TOKEN
  if (adminToken || !existing.has('ADMIN_TOKEN')) { adminToken ||= randomBytes(24).toString('base64url'); secrets.ADMIN_TOKEN = adminToken }
  for (const k of ['TUNNEL_REGISTER_SECRET', 'APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'PLATFORM_OTA_CONTROL_TOKEN', 'PLATFORM_MASTER_TOKEN']) {
    if (env[k]) secrets[k] = env[k]
  }
  if (Object.keys(secrets).length) {
    const tmp = join(worker, '.secrets.tmp.json')
    writeFileSync(tmp, JSON.stringify(secrets))
    try { run('npx', ['wrangler', 'secret', 'bulk', '.secrets.tmp.json', '-c', 'wrangler.generated.json'], { retries: 3 }) } finally { try { unlinkSync(tmp) } catch { } }
  }
  if (existsSync(envFile)) {
    const c = parseJsonc(readFileSync(envFile, 'utf8'))
    const filled = []
    const fill = (k, v) => { if (v && !c[k]) { c[k] = v; filled.push(k) } }
    fill('CLOUDFLARE_ACCOUNT_ID', acct)
    fill('PUBLIC_BASE_URL', url)
    if (r2 !== 'disabled') fill('R2_BUCKET', r2)
    fill('ADMIN_TOKEN', secrets.ADMIN_TOKEN || adminToken)
    if (filled.length) {
      writeFileSync(envFile, JSON.stringify(c, null, 2) + '\n')
      console.log('  backfilled into env.json:', filled.join(', '))
    }
  }

  step(6, 'admin account')
  const out = { url, adminToken: adminToken ?? '(unchanged, previously set)', r2 }
  if (url && env.ADMIN_EMAIL && env.ADMIN_PASSWORD && adminToken) {
    await new Promise(r => setTimeout(r, 6000))
    try {
      const r = await fetch(`${url}/api/platform/v1/admin/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) })
      console.log('  bootstrap HTTP', r.status, r.status === 200 ? '' : await r.text()); out.admin = env.ADMIN_EMAIL
    } catch (e) {
      console.log(`  could not reach ${url} (${e.message}). If workers.dev is blocked, bind a custom domain then run:`)
      console.log(`  curl -X POST ${url}/api/platform/v1/admin/bootstrap -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{"email":"...","password":"...(>=12)"}'`)
    }
  }
  writeFileSync(join(base, 'deploy-output.json'), JSON.stringify(out, null, 2))
  console.log(`\nDone -> ${url ?? ''}\nConsole: ${url ?? ''}/platform/   Tunnel: ${(url ?? '').replace('https', 'wss')}/tunnel\nSummary saved to deploy-output.json (gitignored).`)
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) main()
