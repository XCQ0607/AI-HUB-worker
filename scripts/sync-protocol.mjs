#!/usr/bin/env node
// Lockfile + Codegen sync against upstream WNLUO/dsh-mobile-server.
// Usage:
//   node scripts/sync-protocol.mjs check              validate protocol/upstream.lock.json and worker/src/protocol.generated.ts (offline)
//   node scripts/sync-protocol.mjs sync [--dry-run] [--json]
//                                                    fetch upstream main from GitHub, update lockfile & codegen
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'protocol', 'upstream.lock.json')
const genPath = join(root, 'worker', 'src', 'protocol.generated.ts')

const args = process.argv.slice(2)
const cmd = args.find(a => !a.startsWith('-')) || 'check'
const dryRun = args.includes('--dry-run')
const jsonOut = args.includes('--json')

function parseHexOrNum(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const s = v.trim()
    return s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : Number(s)
  }
  return NaN
}

function validateLock(lock) {
  const problems = []
  if (!lock || typeof lock !== 'object') {
    problems.push('lockfile 不是有效的 JSON 对象')
    return problems
  }
  if (!Number.isInteger(lock.headerLen) || lock.headerLen <= 0) {
    problems.push(`headerLen 必须是正整数，当前为: ${lock.headerLen}`)
  }
  if (typeof lock.mobilePrefix !== 'string' || !lock.mobilePrefix) {
    problems.push(`mobilePrefix 必须是非空字符串，当前为: ${lock.mobilePrefix}`)
  }
  if (!Array.isArray(lock.ownedPaths) || lock.ownedPaths.length === 0 || !lock.ownedPaths.every(p => typeof p === 'string')) {
    problems.push('ownedPaths 必须是非空字符串数组')
  }
  if (!Array.isArray(lock.reservedCloseCodes) || !lock.reservedCloseCodes.every(c => Number.isInteger(c))) {
    problems.push('reservedCloseCodes 必须是整数数组')
  }
  const frameEntries = Object.entries(lock.frameTypes || {})
  if (frameEntries.length === 0) {
    problems.push('frameTypes 不能为空')
  }
  const seenOpcodes = new Map()
  for (const [k, raw] of frameEntries) {
    const v = parseHexOrNum(raw)
    if (!Number.isInteger(v) || v < 0x01 || v > 0x1e) {
      problems.push(`帧类型操作码超出允许范围 (0x01–0x1E): ${k} = ${raw}`)
    } else if (seenOpcodes.has(v)) {
      problems.push(`帧类型操作码重复 (0x${v.toString(16).padStart(2, '0')}): ${seenOpcodes.get(v)} 与 ${k}`)
    } else {
      seenOpcodes.set(v, k)
    }
  }
  return problems
}

function renderGeneratedTs(lock) {
  const frameLines = Object.entries(lock.frameTypes || {}).map(([k, raw]) => {
    const v = parseHexOrNum(raw)
    const hex = '0x' + v.toString(16).padStart(2, '0')
    return `  ${k}: ${hex},`
  })
  const owned = (lock.ownedPaths || []).map(p => JSON.stringify(p).replace(/"/g, "'")).join(', ')
  const reserved = (lock.reservedCloseCodes || []).join(', ')
  const prefix = JSON.stringify(lock.mobilePrefix || '').replace(/"/g, "'")

  return [
    '// AUTO-GENERATED from protocol/upstream.lock.json — DO NOT EDIT.',
    `// Upstream: ${lock.upstream}@${lock.commit} (relay v${lock.relayVersion})`,
    '',
    `export const UPSTREAM_COMMIT = '${lock.commit || ''}'`,
    `export const UPSTREAM_RELAY_VERSION = '${lock.relayVersion || ''}'`,
    '',
    'export const T = {',
    ...frameLines,
    '} as const',
    '',
    `export const HEADER_LEN = ${lock.headerLen}`,
    `export const RESERVED_CLOSE_CODES: readonly number[] = [${reserved}]`,
    `export const OWNED_PATHS: readonly string[] = [${owned}]`,
    `export const MOBILE_PREFIX = ${prefix}`,
    '',
  ].join('\n')
}

function evalProtocolTypes(code) {
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports }, { timeout: 2000 })
  return mod.exports
}

async function fetchText(url) {
  const headers = { 'User-Agent': 'AI-HUB-worker-sync-protocol' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

async function fetchRemoteUpstream(repo = 'WNLUO/dsh-mobile-server') {
  const headers = { 'User-Agent': 'AI-HUB-worker-sync-protocol', Accept: 'application/vnd.github+json' }
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
  const up = evalProtocolTypes(protoCode)
  const frameTypes = {}
  for (const [k, v] of Object.entries(up.T || {})) {
    frameTypes[k] = '0x' + Number(v).toString(16).padStart(2, '0')
  }
  return {
    upstream: repo,
    commit: sha,
    relayVersion: version,
    headerLen: up.HEADER_LEN,
    mobilePrefix: up.MOBILE_PREFIX,
    ownedPaths: up.OWNED_PATHS || [],
    reservedCloseCodes: up.RESERVED_CLOSE_CODES || [],
    frameTypes,
  }
}

function diffLocks(prev, next) {
  const changes = []
  if (!prev) {
    changes.push('首次初始化 protocol/upstream.lock.json')
    return { protocolChanged: true, changes }
  }
  let protocolChanged = false
  if (prev.headerLen !== next.headerLen) {
    protocolChanged = true
    changes.push(`HEADER_LEN 变更: ${prev.headerLen} -> ${next.headerLen}`)
  }
  if (prev.mobilePrefix !== next.mobilePrefix) {
    protocolChanged = true
    changes.push(`MOBILE_PREFIX 变更: ${prev.mobilePrefix} -> ${next.mobilePrefix}`)
  }
  if (JSON.stringify(prev.ownedPaths || []) !== JSON.stringify(next.ownedPaths || [])) {
    protocolChanged = true
    changes.push(`OWNED_PATHS 变更: ${JSON.stringify(prev.ownedPaths)} -> ${JSON.stringify(next.ownedPaths)}`)
  }
  if (JSON.stringify(prev.reservedCloseCodes || []) !== JSON.stringify(next.reservedCloseCodes || [])) {
    protocolChanged = true
    changes.push(`RESERVED_CLOSE_CODES 变更: ${JSON.stringify(prev.reservedCloseCodes)} -> ${JSON.stringify(next.reservedCloseCodes)}`)
  }

  const prevFrames = prev.frameTypes || {}
  const nextFrames = next.frameTypes || {}
  for (const [k, v] of Object.entries(nextFrames)) {
    if (!(k in prevFrames)) {
      protocolChanged = true
      changes.push(`新增帧类型: ${k} = ${v}`)
    } else if (parseHexOrNum(prevFrames[k]) !== parseHexOrNum(v)) {
      protocolChanged = true
      changes.push(`修改帧类型: ${k} (${prevFrames[k]} -> ${v})`)
    }
  }
  for (const [k, v] of Object.entries(prevFrames)) {
    if (!(k in nextFrames)) {
      protocolChanged = true
      changes.push(`移除帧类型: ${k} (${v})`)
    }
  }

  return { protocolChanged, changes }
}

if (cmd === 'check') {
  if (!existsSync(lockPath)) {
    console.error('未找到 protocol/upstream.lock.json')
    process.exit(1)
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const problems = validateLock(lock)
  if (problems.length) {
    console.error('协议锁文件校验失败:\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  const expected = renderGeneratedTs(lock)
  if (!existsSync(genPath)) {
    console.error('缺少生成文件 worker/src/protocol.generated.ts，请运行 npm run protocol:sync 或重新生成')
    process.exit(1)
  }
  const actual = readFileSync(genPath, 'utf8').replace(/\r\n/g, '\n')
  if (actual !== expected) {
    console.error('worker/src/protocol.generated.ts 与 protocol/upstream.lock.json 不一致（可能被手动修改）')
    process.exit(1)
  }
  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, commit: lock.commit, relayVersion: lock.relayVersion, problems: [] }, null, 2))
  } else {
    console.log(`protocol check ok: ${lock.upstream}@${(lock.commit || '').slice(0, 8)} (relay v${lock.relayVersion})`)
  }
} else if (cmd === 'sync') {
  const prev = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null
  const next = await fetchRemoteUpstream(prev?.upstream || 'WNLUO/dsh-mobile-server')
  const problems = validateLock(next)
  const baselineCommit = prev?.commit || ''
  const baselineVersion = prev?.relayVersion || ''
  const upstreamUpdated = Boolean(
    (next.commit && baselineCommit && next.commit !== baselineCommit) ||
    (next.relayVersion && baselineVersion && next.relayVersion !== baselineVersion) ||
    !prev
  )
  const { protocolChanged, changes } = diffLocks(prev, next)

  if (problems.length === 0 && !dryRun) {
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n')
    writeFileSync(genPath, renderGeneratedTs(next))
  }

  const result = {
    upstream: next.upstream,
    commit: next.commit,
    relayVersion: next.relayVersion,
    baselineCommit,
    baselineVersion,
    upstreamUpdated,
    protocolChanged,
    changes,
    checkedAt: new Date().toISOString(),
    problems,
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`上游状态: ${next.upstream}@${next.commit.slice(0, 8)} (relay v${next.relayVersion})`)
    if (upstreamUpdated) {
      console.log(`基线变化: ${baselineCommit.slice(0, 8)} (v${baselineVersion}) -> ${next.commit.slice(0, 8)} (v${next.relayVersion})`)
    } else {
      console.log('上游提交与当前锁文件一致，无需更新。')
    }
    if (changes.length) console.log('协议变更:\n - ' + changes.join('\n - '))
    if (problems.length) console.error('协议校验异常:\n - ' + problems.join('\n - '))
    else if (!dryRun) console.log('已写入 protocol/upstream.lock.json 与 worker/src/protocol.generated.ts')
  }

  if (problems.length > 0) process.exit(1)
} else {
  console.error(`未知子命令: ${cmd}（支持 check / sync）`)
  process.exit(2)
}
