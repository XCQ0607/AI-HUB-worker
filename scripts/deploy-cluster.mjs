#!/usr/bin/env node
// Batch deploy multiple nodes defined in deploy.json (copied from deploy-template.json).
// Usage: node scripts/deploy-cluster.mjs [nodeName...] [--config deploy.json] [--install]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './deploy.mjs'

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

let configArg = 'deploy.json'
let forceInstall = false
const picked = []

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--install') { forceInstall = true; continue }
  if (a === '--config' || a === '-c') {
    if (!argv[i + 1]) throw new Error(`Missing value for ${a}`)
    configArg = argv[++i]
    continue
  }
  if (a.startsWith('--config=')) { configArg = a.slice(9); continue }
  if (a.startsWith('-c=')) { configArg = a.slice(3); continue }
  if (a === '-h' || a === '--help') {
    console.log(`用法: node scripts/deploy-cluster.mjs [节点名...] [--config deploy.json] [--install]`)
    process.exit(0)
  }
  if (!a.startsWith('-')) picked.push(a)
}

const configPath = resolve(base, configArg)
if (!existsSync(configPath)) {
  console.error(`未找到批量部署配置文件: ${configPath}`)
  console.error('请先复制 deploy-template.json 为 deploy.json 并按需填写。')
  process.exit(1)
}

const cfg = parseJsonc(readFileSync(configPath, 'utf8'))
const nodes = Array.isArray(cfg?.nodes) ? cfg.nodes : []
if (!nodes.length) {
  console.error(`${configArg} 中未配置有效的 nodes 数组`)
  process.exit(1)
}

const targets = picked.length
  ? nodes.filter(n => picked.includes(String(n.name || '')))
  : nodes

if (!targets.length) {
  console.error(`未匹配到节点: ${picked.join(', ')}（可用: ${nodes.map(n => n.name).join(', ')}）`)
  process.exit(1)
}

const hasModules = existsSync(join(base, 'worker', 'node_modules')) && existsSync(join(base, 'web', 'node_modules'))

for (const n of targets) {
  const name = String(n.name || n.envFile || 'node')
  const envFile = String(n.envFile || '').trim()
  const profile = String(n.profile || '').trim()
  if (!envFile) {
    console.error(`节点 [${name}] 缺少 envFile`)
    process.exit(1)
  }
  console.log(`\n==============================`)
  console.log(`开始部署 [${name}] -> ${envFile}${profile ? ` (profile: ${profile})` : ''}`)
  console.log(`==============================`)
  const env = { ...process.env }
  if (!forceInstall && hasModules && !env.SKIP_INSTALL) env.SKIP_INSTALL = '1'
  const cmdArgs = ['scripts/deploy.mjs', '--env', envFile]
  if (profile) cmdArgs.push('--profile', profile)
  const r = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'node', ...cmdArgs], { cwd: base, env, stdio: 'inherit' })
    : spawnSync('node', cmdArgs, { cwd: base, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}
