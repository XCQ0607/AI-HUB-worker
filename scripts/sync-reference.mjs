#!/usr/bin/env node
// Sync / drift check against upstream WNLUO/dsh-mobile-server or .github/upstream-baseline.json.
// Usage:
//   node scripts/sync-reference.mjs                  git pull local reference, then check
//   node scripts/sync-reference.mjs --check          compare against local reference (auto-fallback to baseline if missing)
//   node scripts/sync-reference.mjs --check --ci     validate worker/src/protocol.ts against .github/upstream-baseline.json (no .dev/ write)
//   node scripts/sync-reference.mjs --remote         fetch upstream main from GitHub and compare against baseline & protocol.ts
//   node scripts/sync-reference.mjs --ref-dir <dir>  check against an explicit local checkout directory
//   node scripts/sync-reference.mjs --update-baseline  update .github/upstream-baseline.json when protocol is in sync
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, '.github', 'upstream-baseline.json')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const argVal = name => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

const ciMode = flag('--ci')
const checkOnly = flag('--check') || ciMode
const remoteMode = flag('--remote')
const jsonOut = flag('--json')
const updateBaseline = flag('--update-baseline')
const refDirArg = argVal('--ref-dir')
const defaultRef = join(root, 'reference', 'dsh-mobile-server')
const refDir = refDirArg ? resolve(refDirArg) : defaultRef

function evalProtocolTypes(code) {
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports }, { timeout: 2000 })
  return mod.exports
}

function normalizeBaselineToUp(b) {
  const T = {}
  for (const [k, v] of Object.entries(b.frameTypes || {})) {
    T[k] = typeof v === 'string' ? parseInt(v, 16) : Number(v)
  }
  return {
    T,
    HEADER_LEN: b.headerLen,
    MOBILE_PREFIX: b.mobilePrefix,
    OWNED_PATHS: b.ownedPaths || [],
    RESERVED_CLOSE_CODES: b.reservedCloseCodes || [],
  }
}

async function fetchText(url) {
  const headers = { 'User-Agent': 'AI-HUB-worker-sync-reference' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

async function fetchRemoteUpstream(repo = 'WNLUO/dsh-mobile-server') {
  const headers = { 'User-Agent': 'AI-HUB-worker-sync-reference', Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const commitRes = await fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers })
  if (!commitRes.ok) throw new Error(`GitHub API HTTP ${commitRes.status} for ${repo}/commits/main`)
  const commitJson = await commitRes.json()
  const sha = String(commitJson.sha || '')
  const rawBase = `https://raw.githubusercontent.com/${repo}/${sha || 'main'}`
  const [cargo, protoCode] = await Promise.all([
    fetchText(`${rawBase}/server/relay/rust/Cargo.toml`),
    fetchText(`${rawBase}/server/relay-core/protocol-types.js`),
  ])
  const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] || ''
  return { source: 'remote', commit: sha, relayVersion: version, up: evalProtocolTypes(protoCode) }
}

function loadLocalUpstream(dir, doPull) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  if (doPull) {
    const proxy = process.env.HTTPS_PROXY || 'http://127.0.0.1:10808'
    let r = git('pull', '--ff-only')
    if (r.status !== 0) {
      if (!jsonOut) console.log('direct pull failed, retrying via proxy', proxy)
      r = git('-c', `http.proxy=${proxy}`, 'pull', '--ff-only')
    }
    if (!jsonOut) console.log((r.stdout || r.stderr).trim())
  }
  const sha = existsSync(join(dir, '.git')) ? git('rev-parse', 'HEAD').stdout.trim() : ''
  const cargo = readFileSync(join(dir, 'server/relay/rust/Cargo.toml'), 'utf8')
  const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] || ''
  const up = createRequire(import.meta.url)(join(dir, 'server/relay-core/protocol-types.js'))
  return { source: 'local', commit: sha, relayVersion: version, up }
}

function loadBaseline() {
  if (!existsSync(baselinePath)) throw new Error('.github/upstream-baseline.json not found')
  const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
  return { source: 'baseline', commit: b.commit || '', relayVersion: b.relayVersion || '', up: normalizeBaselineToUp(b) }
}

function parseLocalProtocol(mine) {
  const tBlock = /export\s+const\s+T\s*=\s*\{([\s\S]*?)\}\s*as\s+const/.exec(mine)
  const localT = {}
  if (tBlock) {
    const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)/g
    let m
    while ((m = re.exec(tBlock[1])) !== null) {
      localT[m[1]] = m[2].toLowerCase().startsWith('0x') ? parseInt(m[2], 16) : Number(m[2])
    }
  }
  const headerLen = Number(/export\s+const\s+HEADER_LEN\s*=\s*(\d+)/.exec(mine)?.[1] ?? NaN)
  const mobilePrefix = /export\s+const\s+MOBILE_PREFIX\s*=\s*['"]([^'"]+)['"]/.exec(mine)?.[1] ?? ''
  const ownedRaw = /export\s+const\s+OWNED_PATHS\s*=\s*\[([^\]]+)\]/.exec(mine)?.[1] ?? ''
  const ownedPaths = [...ownedRaw.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1])
  const reservedRaw = /export\s+const\s+RESERVED_CLOSE_CODES\s*=\s*\[([^\]]+)\]/.exec(mine)?.[1] ?? ''
  const reservedCloseCodes = [...reservedRaw.matchAll(/\d+/g)].map(m => Number(m[0]))
  return { localT, headerLen, mobilePrefix, ownedPaths, reservedCloseCodes }
}

let refInfo
if (remoteMode) {
  refInfo = await fetchRemoteUpstream()
} else if (refDirArg) {
  if (!existsSync(refDir)) { console.error(`ref-dir not found: ${refDir}`); process.exit(2) }
  refInfo = loadLocalUpstream(refDir, false)
} else if (ciMode) {
  refInfo = loadBaseline()
} else if (existsSync(refDir)) {
  refInfo = loadLocalUpstream(refDir, !checkOnly)
} else if (checkOnly && existsSync(baselinePath)) {
  if (!jsonOut) console.log('reference/dsh-mobile-server not found; falling back to .github/upstream-baseline.json')
  refInfo = loadBaseline()
} else {
  console.error('reference/dsh-mobile-server not found. git clone https://github.com/WNLUO/dsh-mobile-server reference/dsh-mobile-server')
  process.exit(2)
}

const { up, commit: sha, relayVersion: version, source } = refInfo
const mine = readFileSync(join(root, 'worker/src/protocol.ts'), 'utf8')
const local = parseLocalProtocol(mine)
const problems = []

for (const [k, v] of Object.entries(up.T)) {
  if (v < 0x01 || v > 0x1e) problems.push(`upstream opcode out of 0x01-0x1E range: ${k} = 0x${v.toString(16)}`)
  if (!(k in local.localT)) problems.push(`missing frame type: ${k} = 0x${v.toString(16)}`)
  else if (local.localT[k] !== v) problems.push(`frame type mismatch: ${k} upstream 0x${v.toString(16)} vs local 0x${local.localT[k].toString(16)}`)
}
for (const [k, v] of Object.entries(local.localT)) {
  if (v >= 0x1f || v < 0x01) problems.push(`disallowed frame opcode (0x1F+ forbidden): ${k} = 0x${v.toString(16)}`)
  else if (!(k in up.T)) problems.push(`extra local frame type not in upstream: ${k} = 0x${v.toString(16)}`)
}
for (const p of up.OWNED_PATHS) if (!local.ownedPaths.includes(p)) problems.push(`missing owned path: ${p}`)
if (local.mobilePrefix !== up.MOBILE_PREFIX) problems.push(`MOBILE_PREFIX differs: ${local.mobilePrefix} vs ${up.MOBILE_PREFIX}`)
if (local.headerLen !== up.HEADER_LEN) problems.push(`HEADER_LEN differs: ${local.headerLen} vs ${up.HEADER_LEN}`)
for (const c of up.RESERVED_CLOSE_CODES || []) {
  if (!local.reservedCloseCodes.includes(c)) problems.push(`missing reserved close code: ${c}`)
}

let baselineCommit = ''
let baselineVersion = ''
let upstreamUpdated = false
if (existsSync(baselinePath)) {
  const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
  baselineCommit = b.commit || ''
  baselineVersion = b.relayVersion || ''
  if (sha && baselineCommit && sha !== baselineCommit) upstreamUpdated = true
  if (version && baselineVersion && version !== baselineVersion) upstreamUpdated = true
}

if (updateBaseline) {
  if (source === 'baseline') {
    console.error('cannot --update-baseline from baseline itself; need local reference, --ref-dir, or --remote')
    process.exit(2)
  }
  if (problems.length) {
    console.error('refusing --update-baseline while protocol drift exists:\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  const frameTypes = {}
  for (const [k, v] of Object.entries(up.T)) frameTypes[k] = '0x' + v.toString(16).padStart(2, '0')
  const nextBaseline = {
    upstream: 'WNLUO/dsh-mobile-server',
    commit: sha,
    relayVersion: version,
    headerLen: up.HEADER_LEN,
    mobilePrefix: up.MOBILE_PREFIX,
    ownedPaths: up.OWNED_PATHS,
    reservedCloseCodes: up.RESERVED_CLOSE_CODES,
    frameTypes,
  }
  writeFileSync(baselinePath, JSON.stringify(nextBaseline, null, 2) + '\n')
  if (!jsonOut) console.log(`updated .github/upstream-baseline.json -> ${sha.slice(0, 8)} relay v${version}`)
}

const result = {
  upstream: 'WNLUO/dsh-mobile-server',
  source,
  commit: sha,
  relayVersion: version,
  baselineCommit,
  baselineVersion,
  upstreamUpdated,
  checkedAt: new Date().toISOString(),
  problems,
}

if (!ciMode && !refDirArg) {
  mkdirSync(join(root, '.dev'), { recursive: true })
  writeFileSync(join(root, '.dev/reference-sync.json'), JSON.stringify({
    upstream: result.upstream,
    commit: sha,
    relayVersion: version,
    checkedAt: result.checkedAt,
    problems,
  }, null, 2))
}

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`source=${source}  upstream ${sha ? sha.slice(0, 8) : '(unknown)'}  relay v${version}`)
  if (upstreamUpdated) console.log(`upstream differs from baseline (${baselineCommit.slice(0, 8)} v${baselineVersion})`)
  if (!problems.length) console.log('protocol table in sync (0x01-0x1E)')
}

if (problems.length) {
  if (!jsonOut) console.error('PROTOCOL DRIFT:\n - ' + problems.join('\n - '))
  process.exit(1)
}
