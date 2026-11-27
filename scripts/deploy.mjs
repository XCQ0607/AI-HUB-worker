#!/usr/bin/env node
// One-command deploy:  node scripts/deploy.mjs [--env env2.json] [--profile slave]
// Auth (first match wins): CLOUDFLARE_API_TOKEN | CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY | existing `wrangler login` session.
// Config comes from env.json by default (or --env / ENV_FILE; gitignored); real environment variables take priority.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  let cliEnv = '', cliProfile = ''
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env' || a === '-e') {
      if (!argv[i + 1]) throw new Error(`Missing value for ${a}`)
      cliEnv = argv[++i]
    } else if (a.startsWith('--env=')) { cliEnv = a.slice(6) }
    else if (a.startsWith('-e=')) { cliEnv = a.slice(3) }
    else if (a === '--profile' || a === '-p') {
      if (!argv[i + 1]) throw new Error(`Missing value for ${a}`)
      cliProfile = argv[++i]
    } else if (a.startsWith('--profile=')) { cliProfile = a.slice(10) }
    else if (a.startsWith('-p=')) { cliProfile = a.slice(3) }
  }
  const explicitEnv = Boolean(cliEnv || process.env.ENV_FILE)
  const envArg = cliEnv || process.env.ENV_FILE || 'env.json'
  const envFile = resolve(base, envArg)
  const envLabel = basename(envFile)
  if (explicitEnv && !existsSync(envFile)) throw new Error(`Config file not found: ${envFile}`)
  if (existsSync(envFile)) {
    for (const [k, v] of Object.entries(parseJsonc(readFileSync(envFile, 'utf8')))) {
      if (!k.startsWith('_') && v !== '' && v != null && !env[k]) env[k] = String(v)
    }
    console.log(`Loaded config from ${envLabel}`)
  }
  const name = env.WORKER_NAME || 'ai-hub-relay'
  const wranglerProfile = cliProfile || env.WRANGLER_PROFILE || ''
  function run(cmd, args, { cwd = worker, input, allowFail, retries = 1 } = {}) {
    let r
    for (let i = 0; i < retries; i++) {
      if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i * 4000)
      r = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd, ...args], { cwd, env, encoding: 'utf8', input })
        : spawnSync(cmd, args, { cwd, env, encoding: 'utf8', input })
      if (r.status === 0) return r
    }
    if (!allowFail) { console.error(r.stdout, r.stderr); throw new Error(`${cmd} ${args.join(' ')} failed`) }
    return r
  }
  const wrangler = (args, opts) => run('npx', ['wrangler', ...args, ...(wranglerProfile ? ['--profile', wranglerProfile] : [])], opts)
  const step = (n, t) => console.log(`\n[${n}/6] ${t}`)

  let cachedClient = null
  async function getHttpClient() {
    if (cachedClient) return cachedClient
    let fetchFn = fetch, dispatcher
    const proxy = env.HTTPS_PROXY || env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    if (proxy && existsSync(join(worker, 'node_modules', 'undici', 'index.js'))) {
      const u = await import(pathToFileURL(join(worker, 'node_modules', 'undici', 'index.js')).href)
      fetchFn = u.fetch; dispatcher = new u.ProxyAgent(proxy)
    }
    cachedClient = { fetchFn, dispatcher }
    return cachedClient
  }

  let headers = null
  if (env.CLOUDFLARE_API_TOKEN) headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
  else if (env.CLOUDFLARE_EMAIL && env.CLOUDFLARE_API_KEY) headers = { 'X-Auth-Email': env.CLOUDFLARE_EMAIL, 'X-Auth-Key': env.CLOUDFLARE_API_KEY }
  console.log('Auth mode:', env.CLOUDFLARE_API_TOKEN ? 'API Token' : headers ? 'Global API Key' : `wrangler OAuth${wranglerProfile ? ` (profile: ${wranglerProfile})` : ''}`)
  // wrangler reads CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY itself; clear stale email when API key is empty so OAuth works cleanly.
  if (!env.CLOUDFLARE_API_KEY) delete env.CLOUDFLARE_EMAIL
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_API_KEY']) if (!env[k]) delete env[k]

  async function cf(path, h = headers) {
    const { fetchFn, dispatcher } = await getHttpClient()
    const res = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { 'Content-Type': 'application/json', ...h },
      ...(dispatcher ? { dispatcher } : {}),
    })
    const j = await res.json()
    if (!j.success) throw new Error(`${path}: ${j.errors?.map(e => e.message).join('; ')}`)
    return j.result
  }
  function oauthHeaders() {
    const r = wrangler(['auth', 'token'], { allowFail: true })
    const tok = (r.stdout || '').trim().split(/\r?\n/).pop()?.trim()
    return tok && tok.length > 20 ? { Authorization: `Bearer ${tok}` } : null
  }
  const isWorkersDev = u => /^https?:\/\/[^/]+\.workers\.dev(?:\/|$)/i.test(String(u || '').trim())
  let cachedCfHeaders
  function getCfHeaders() {
    if (cachedCfHeaders === undefined) cachedCfHeaders = headers ?? oauthHeaders() ?? null
    return cachedCfHeaders
  }
  async function detectCustomDomain(accountId, serviceName) {
    if (!accountId || !serviceName) return null
    const h = getCfHeaders()
    if (!h) return null
    try {
      const list = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains?service=${encodeURIComponent(serviceName)}`, h)
      if (!Array.isArray(list)) return null
      const matched = list.filter(d => d && d.service === serviceName && d.enabled !== false && d.hostname)
      const pick = matched.find(d => !d.environment || d.environment === 'production') || matched[0]
      return pick ? `https://${String(pick.hostname).replace(/^https?:\/\//i, '').replace(/\/+$/, '')}` : null
    } catch (e) {
      console.log(`  cannot auto-detect custom domain (${e.message}); falling back to workers.dev`)
      return null
    }
  }
  const npmInstallArgs = dir => [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund']

  step(1, 'install dependencies & build admin console')
  const skipInstall = (process.env.SKIP_INSTALL || env.SKIP_INSTALL) === '1'
  if (!skipInstall) run('npm', npmInstallArgs(worker), { cwd: worker, retries: 2 })
  if (existsSync(join(web, 'package.json'))) {
    if (!skipInstall) run('npm', npmInstallArgs(web), { cwd: web, retries: 2 })
    run('npm', ['run', 'build'], { cwd: web })
  } else if (!existsSync(join(worker, 'public', 'platform', 'index.html'))) throw new Error('web/ missing and worker/public not built')

  step(2, 'resolve Cloudflare account')
  let acct = env.CLOUDFLARE_ACCOUNT_ID
  if (!acct) {
    try {
      const list = await cf('/accounts', getCfHeaders() ?? {})
      if (list.length === 1) acct = list[0].id
      else throw new Error(`found ${list.length} accounts: ${list.map(a => `${a.name}=${a.id}`).join(', ')}`)
    } catch (e) { console.log(`  cannot auto-detect account (${e.message}); set CLOUDFLARE_ACCOUNT_ID if wrangler complains`) }
  }
  if (acct) { env.CLOUDFLARE_ACCOUNT_ID = acct; console.log('  account', acct) }

  step(3, 'R2 bucket (optional, for history blobs)')
  const configuredUrl = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '') : ''
  let detectedCustomUrl = null
  if (!configuredUrl || isWorkersDev(configuredUrl)) {
    detectedCustomUrl = await detectCustomDomain(acct, name)
    if (detectedCustomUrl) console.log('  detected custom domain:', detectedCustomUrl)
  }
  const preferredUrl = detectedCustomUrl || (configuredUrl && !isWorkersDev(configuredUrl) ? configuredUrl : '')
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
  ]) {
    if (env[k]) cfg.vars[k] = env[k]
  }
  const initialPublicUrl = preferredUrl || configuredUrl
  if (initialPublicUrl) cfg.vars.PUBLIC_BASE_URL = initialPublicUrl
  let r2 = 'disabled'
  if (env.ENABLE_R2 !== '0') {
    const bucket = env.R2_BUCKET || 'ai-hub-blob'
    const r = wrangler(['r2', 'bucket', 'create', bucket], { allowFail: true })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status === 0 || /already exists/i.test(out)) { cfg.r2_buckets = [{ binding: 'BLOB', bucket_name: bucket }]; r2 = bucket }
    else console.log('  R2 unavailable (not enabled on this account?) -> blobs disabled.', out.split('\n').find(l => /error/i.test(l)) ?? '')
  }
  const genFile = join(worker, 'wrangler.generated.json')
  writeFileSync(genFile, JSON.stringify(cfg, null, 2))

  step(4, 'deploy worker')
  const dep = wrangler(['deploy', '-c', 'wrangler.generated.json'], { retries: 3 })
  const workersDevUrl = /https:\/\/[^\s]+workers\.dev/.exec(dep.stdout + dep.stderr)?.[0]?.replace(/\/+$/, '')
  const url = preferredUrl || workersDevUrl || configuredUrl || undefined
  console.log('  ', url ?? '(worker URL not detected)')
  if (url && cfg.vars.PUBLIC_BASE_URL !== url) {
    cfg.vars.PUBLIC_BASE_URL = url
    writeFileSync(genFile, JSON.stringify(cfg, null, 2))
    console.log('  syncing auto-detected PUBLIC_BASE_URL into worker vars')
    wrangler(['deploy', '-c', 'wrangler.generated.json'], { retries: 3 })
  }

  step(5, 'secrets')
  const listed = wrangler(['secret', 'list', '-c', 'wrangler.generated.json', '--format', 'json'], { allowFail: true })
  const existing = new Set((() => { try { return JSON.parse(listed.stdout).map(s => s.name) } catch { return [] } })())
  const secrets = {}
  let adminToken = env.ADMIN_TOKEN
  if (adminToken || !existing.has('ADMIN_TOKEN')) { adminToken ||= randomBytes(24).toString('base64url'); secrets.ADMIN_TOKEN = adminToken }
  for (const k of ['TUNNEL_REGISTER_SECRET', 'PLATFORM_OTA_CONTROL_TOKEN', 'PLATFORM_MASTER_TOKEN']) {
    if (env[k]) secrets[k] = env[k]
  }
  if (Object.keys(secrets).length) {
    const tmp = join(worker, '.secrets.tmp.json')
    writeFileSync(tmp, JSON.stringify(secrets))
    try { wrangler(['secret', 'bulk', '.secrets.tmp.json', '-c', 'wrangler.generated.json'], { retries: 3 }) } finally { try { unlinkSync(tmp) } catch { } }
  }
  if (existsSync(envFile)) {
    const c = parseJsonc(readFileSync(envFile, 'utf8'))
    const filled = []
    const fill = (k, v) => { if (v && !c[k]) { c[k] = v; filled.push(k) } }
    fill('CLOUDFLARE_ACCOUNT_ID', acct)
    if (url && (!c.PUBLIC_BASE_URL || (isWorkersDev(c.PUBLIC_BASE_URL) && !isWorkersDev(url)))) {
      c.PUBLIC_BASE_URL = url
      filled.push('PUBLIC_BASE_URL')
    }
    if (r2 !== 'disabled') fill('R2_BUCKET', r2)
    fill('ADMIN_TOKEN', secrets.ADMIN_TOKEN || adminToken)
    if (filled.length) {
      writeFileSync(envFile, JSON.stringify(c, null, 2) + '\n')
      console.log(`  backfilled into ${envLabel}:`, filled.join(', '))
    }
  }

  step(6, 'admin account')
  const out = { url, adminToken: adminToken ?? '(unchanged, previously set)', r2 }
  if (url && env.ADMIN_EMAIL && env.ADMIN_PASSWORD && adminToken) {
    await new Promise(r => setTimeout(r, 6000))
    try {
      const { fetchFn, dispatcher } = await getHttpClient()
      const r = await fetchFn(`${url}/api/platform/v1/admin/bootstrap`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
        ...(dispatcher ? { dispatcher } : {}),
      })
      console.log('  bootstrap HTTP', r.status, r.status === 200 ? '' : await r.text()); out.admin = env.ADMIN_EMAIL
    } catch (e) {
      console.log(`  could not reach ${url} (${e.message}). If workers.dev is blocked, bind a custom domain then run:`)
      console.log(`  curl -X POST ${url}/api/platform/v1/admin/bootstrap -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{"email":"...","password":"...(>=12)"}'`)
    }
  }
  writeFileSync(join(base, 'deploy-output.json'), JSON.stringify(out, null, 2))
  console.log(`\nDone -> ${url ?? ''}\nConsole: ${url ?? ''}/platform/   Tunnel: ${(url ?? '').replace('https', 'wss')}/tunnel\nSummary saved to deploy-output.json`)
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) main()
