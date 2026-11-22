import { useCallback, useEffect, useState } from 'react'
import { Activity, Bell, CheckCircle2, Compass, Database, Globe, HardDrive, KeyRound, Network, Package, Plug, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { api, ago, bytes, shortId } from '../api'
import { actionTone, Badge, Card, CopyBtn, EmptyState, Modal, ProgressBar, StatCard, useToast } from '../components/ui'

interface DiagStep { name: string; ok: boolean; ms: number; detail: string }
interface TelemetryHour { hour: number; label: string; reqs: number; bytesIn: number; bytesOut: number; mirrorHits: number }
interface TelemetryData {
  hours: TelemetryHour[]
  topInstances: Array<{ id: string; version: string; reqCount: number; bytesIn: number; bytesOut: number; lastSeen: number }>
  quota: { dailyReqLimit: number; todayReqs: number; sqlRows: number; activeTunnels: number; r2Bytes: number }
}

export function Overview({ onNav }: { onNav: (tab: any) => void }) {
  const toast = useToast()
  const [o, setO] = useState<any>(null)
  const [tel, setTel] = useState<TelemetryData | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [audit, setAudit] = useState<any[]>([])
  const [diagSteps, setDiagSteps] = useState<DiagStep[]>([])
  const [probing, setProbing] = useState(false)

  // Onboarding wizard modal
  const [wizardOpen, setWizardOpen] = useState(false)
  const [licenses, setLicenses] = useState<any[]>([])
  const [selLic, setSelLic] = useState('')

  const load = useCallback(async () => {
    try {
      const [ov, au, tm] = await Promise.all([
        api('/overview'),
        api('/audit').catch(() => ({ items: [] })),
        api<TelemetryData>('/telemetry').catch(() => null),
      ])
      setO(ov)
      setAudit((au.items ?? []).slice(0, 6))
      if (tm) setTel(tm)
    } catch (e: any) { toast(e.message, 'error') }
  }, [toast])

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])

  const openWizard = async () => {
    setWizardOpen(true)
    try {
      const r = await api<{ items: any[] }>('/licenses')
      const now = Date.now()
      const active = (r.items ?? []).filter(l => l.status === 'active' && (!l.expiresAt || l.expiresAt > now))
      setLicenses(active)
      if (!selLic && active[0]) setSelLic(active[0].code)
    } catch { /* ignore */ }
  }

  const runDiagnostics = async () => {
    setProbing(true)
    const steps: DiagStep[] = []
    // Step 1: /healthz
    let t0 = performance.now()
    try {
      const r = await fetch('/healthz')
      const txt = await r.text()
      steps.push({ name: '1. Worker /healthz 存活', ok: r.ok && txt.trim() === 'ok', ms: Math.round(performance.now() - t0), detail: `HTTP ${r.status} (${txt.trim()})` })
    } catch (e: any) {
      steps.push({ name: '1. Worker /healthz 存活', ok: false, ms: Math.round(performance.now() - t0), detail: e?.message ?? '请求失败' })
    }
    setDiagSteps([...steps])

    // Step 2: /api/mobile/v1/health + /diagnostics ticket
    t0 = performance.now()
    let ticket = '', colo = o?.colo || 'LOCAL'
    try {
      const [mh, dg] = await Promise.all([fetch('/api/mobile/v1/health').then(r => r.json()), api<any>('/diagnostics')])
      ticket = dg.wssProbeTicket || ''
      colo = dg.colo || colo
      steps.push({ name: '2. 移动端体检 & 边缘节点', ok: mh?.ok === true, ms: Math.round(performance.now() - t0), detail: `service=${mh?.service} · PoP=${colo}` })
    } catch (e: any) {
      steps.push({ name: '2. 移动端体检 & 边缘节点', ok: false, ms: Math.round(performance.now() - t0), detail: e?.message ?? '失败' })
    }
    setDiagSteps([...steps])

    // Step 3: Browser WSS /tunnel handshake
    t0 = performance.now()
    if (!ticket) {
      steps.push({ name: '3. 浏览器到边缘 WSS /tunnel 握手', ok: false, ms: 0, detail: '未获取到诊断凭据，跳过 WSS 探测' })
      setDiagSteps([...steps])
      setProbing(false)
      toast('诊断发现异常，请查看详情', 'error')
      return
    }
    await new Promise<void>(resolve => {
      const wsBase = location.origin.replace(/^http/, 'ws')
      const ws = new WebSocket(`${wsBase}/tunnel?diag=${encodeURIComponent(ticket)}`)
      let settled = false
      const done = (ok: boolean, detail: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        steps.push({ name: '3. 浏览器到边缘 WSS /tunnel 握手', ok, ms: Math.round(performance.now() - t0), detail })
        resolve()
      }
      const timer = setTimeout(() => { try { ws.close() } catch { /* */ } done(false, '握手超时 (5s)') }, 5000)
      ws.onmessage = ev => {
        try {
          const d = JSON.parse(String(ev.data))
          done(d.ok === true, `WSS 连通 (PoP=${d.colo || colo})`)
        } catch {
          done(true, 'WSS 连通')
        }
      }
      ws.onerror = () => done(false, 'WSS 握手失败（请检查代理或 TLS）')
      ws.onclose = ev => done(false, `WSS 连接关闭 (code=${ev.code})`)
    })
    setDiagSteps([...steps])
    setProbing(false)
    toast(steps.every(s => s.ok) ? '诊断全部通过' : '诊断发现异常，请查看详情', steps.every(s => s.ok) ? 'success' : 'error')
  }

  const origin = location.origin
  const wsUrl = origin.replace(/^http/, 'ws') + '/tunnel'
  const relayConfigJson = JSON.stringify(
    selLic ? { relayUrl: origin, licenseCode: selLic } : { relayUrl: origin },
    null,
    2,
  )
  const headlessSnippet = [
    `# 方式 A：写入宿主 ~/.dsh/relay.json（或通过桌面插件面板 / POST /api/relay/config 设置）`,
    relayConfigJson,
    ``,
    `# 方式 B：若中转端启用了 TUNNEL_REGISTER_SECRET，在宿主进程中设置环境变量：`,
    `export DSH_RELAY_REGISTER_SECRET="your-secret"`,
  ].join('\n')

  if (!o) return <p className="muted pad">正在加载概览数据…</p>

  return (
    <div className="stack">
      <div className="row-between">
        <div className="btn-row">
          <Badge tone="cyan" icon={<Globe size={12} />}>边缘节点 {o.colo || 'LOCAL'}{o.country ? ` · ${o.country}` : ''}</Badge>
          <Badge tone={o.online > 0 ? 'ok' : 'neutral'} dot>{o.online > 0 ? `${o.online} 台宿主在线` : '等待宿主连入'}</Badge>
        </div>
        <div className="btn-row">
          <button className="btn-primary btn-sm" onClick={openWizard}><Compass size={14} />接入向导</button>
          <button className="icon-btn" onClick={load} title="刷新" aria-label="刷新概览"><RefreshCw size={14} /></button>
        </div>
      </div>

      <div className="grid">
        <StatCard label="在线宿主" value={o.online} hint={`累计接入 ${o.instances} 个实例`} onClick={() => onNav('tunnels')}
          tone={o.online > 0 ? 'ok' : undefined} icon={<Plug size={16} className={o.online > 0 ? 'ok' : 'muted'} />} />
        <StatCard label="准入模式" value={o.mode === 'restricted' ? '限制模式' : '开放模式'} onClick={() => onNav('licenses')}
          hint={o.modeControlled ? '由主控端接管' : o.mode === 'restricted' ? '握手需携带有效激活码' : '任意宿主可建隧道'}
          tone={o.mode === 'restricted' ? 'warn' : 'accent'} icon={<ShieldCheck size={16} className="muted" />} />
        <StatCard label="激活码 / 设备" value={`${o.activeLicenses} / ${o.licenses}`} onClick={() => onNav('licenses')}
          hint={`已绑定 ${o.devicesBound} 台设备`} icon={<KeyRound size={16} className="muted" />} />
        <StatCard label="离线镜像 (Mirror)" value={o.mirror?.enabled ? `${o.mirror.instances} 实例` : '已关闭'} onClick={() => onNav('storage')}
          hint={o.mirror?.enabled ? `${bytes(o.mirror.bytes)} / ${bytes(o.mirror.budget)}` : '可在设置中开启'}
          icon={<HardDrive size={16} className="muted" />} />
        <StatCard label="历史 Blob (R2)" value={o.blob?.enabled ? `${o.blob.count} 条` : '未绑定'} onClick={() => onNav('storage')}
          hint={o.blob?.enabled ? bytes(o.blob.bytes) : '部署时 ENABLE_R2=1 启用'}
          icon={<Database size={16} className="muted" />} />
        <StatCard label="APNs 离线推送" value={o.apns?.enabled ? `${o.apns.tokens} 台` : '未配置'} onClick={() => onNav('storage')}
          hint={o.apns?.enabled ? '推送密钥已配置' : '可改用 Webhook 桥接'}
          icon={<Bell size={16} className="muted" />} />
        <StatCard label="节点联邦" value={o.role === 'slave' ? '被控端' : `${o.nodes?.online ?? 0} / ${o.nodes?.total ?? 0}`} onClick={() => onNav('nodes')}
          hint={o.role === 'slave' ? (o.masterLastError ? '上报异常' : o.masterLastReportAt ? '已挂载主控端' : '待首次上报（需配置认领码）') : '在线 / 全部被控节点'}
          icon={<Network size={16} className="muted" />} />
        <StatCard label="插件 OTA / 迁移" value={`${o.ota?.count ?? 0} / ${o.migrations ?? 0}`} onClick={() => onNav('ota')}
          hint={`最低版本门槛: ${o.minVersion || '不限'}`}
          icon={<Package size={16} className="muted" />} />
      </div>

      <div className="two-col">
        <Card title="24 小时流量遥测 (UTC)" subtitle={tel ? `累计 ${tel.quota.todayReqs} 次请求` : '加载遥测中…'}>
          {!tel ? <p className="muted small">暂无遥测数据</p> : (() => {
            const maxR = Math.max(1, ...tel.hours.map(h => h.reqs))
            const totalBytes = tel.hours.reduce((a, h) => a + h.bytesIn + h.bytesOut, 0)
            const totalMirror = tel.hours.reduce((a, h) => a + h.mirrorHits, 0)
            const hovered = hoverIdx !== null ? tel.hours[hoverIdx] : null
            return (
              <div className="stack-xs">
                <div style={{ minHeight: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  {hovered ? (
                    <Badge tone="accent">
                      {hovered.label} · {hovered.reqs} reqs · 镜像 {hovered.mirrorHits} · {bytes(hovered.bytesIn + hovered.bytesOut)}
                    </Badge>
                  ) : (
                    <span className="muted small">悬停或聚焦柱条查看各时段明细</span>
                  )}
                </div>
                <svg viewBox="0 0 480 128" style={{ width: '100%', height: 136, display: 'block' }} onMouseLeave={() => setHoverIdx(null)} role="img" aria-label="24 小时流量遥测柱状图">
                  {[0.25, 0.5, 0.75, 1].map(g => (
                    <line key={g} x1={0} x2={480} y1={108 - g * 92} y2={108 - g * 92} stroke="var(--line)" strokeDasharray="3 3" />
                  ))}
                  {tel.hours.map((h, i) => {
                    const x = i * 20 + 3
                    const bh = Math.max(h.reqs > 0 ? 4 : 2, Math.round((h.reqs / maxR) * 92))
                    const mh = h.mirrorHits > 0 ? Math.max(3, Math.round((h.mirrorHits / maxR) * 92)) : 0
                    const active = hoverIdx === i
                    return (
                      <g
                        key={h.hour}
                        tabIndex={0}
                        role="button"
                        aria-label={`${h.label}：${h.reqs} 次请求，离线镜像命中 ${h.mirrorHits} 次，流量 ${bytes(h.bytesIn + h.bytesOut)}`}
                        onMouseEnter={() => setHoverIdx(i)}
                        onFocus={() => setHoverIdx(i)}
                        onClick={() => setHoverIdx(prev => (prev === i ? null : i))}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHoverIdx(i) } }}
                        style={{ cursor: 'pointer', outline: 'none' }}
                      >
                        <rect x={x - 2} y={8} width={18} height={104} fill={active ? 'var(--accent-soft)' : 'transparent'} rx={4} />
                        <rect x={x} y={108 - bh} width={14} height={bh} rx={3} fill={h.reqs > 0 ? (active ? 'var(--accent)' : 'rgba(99, 102, 241, 0.72)') : 'var(--line)'} />
                        {mh > 0 && <rect x={x} y={108 - Math.min(bh, mh)} width={14} height={Math.min(bh, mh)} rx={2} fill="var(--ok)" />}
                        {i % 4 === 0 && <text x={x + 7} y={123} textAnchor="middle" fontSize="9" fill="var(--muted)">{h.label}</text>}
                      </g>
                    )
                  })}
                </svg>
                <div className="row-between muted small">
                  <span>24h 总吞吐：{bytes(totalBytes)}</span>
                  <span>离线镜像命中：{totalMirror} 次</span>
                </div>
              </div>
            )
          })()}
        </Card>

        <Card title="免费额度用量" subtitle="Workers 日请求量、DO SQLite 与活跃隧道">
          {!tel ? <p className="muted small">加载中…</p> : (
            <div className="stack-xs">
              <div>
                <div className="row-between small" style={{ marginBottom: 4 }}>
                  <span className="muted">24h 请求量 / 免费日限额</span>
                  <span>{tel.quota.todayReqs} / {tel.quota.dailyReqLimit.toLocaleString()}</span>
                </div>
                <ProgressBar value={tel.quota.todayReqs} max={tel.quota.dailyReqLimit} />
              </div>
              <div className="kv-list">
                <div className="kv-row"><span className="muted">DO SQLite 累计记录行数</span><span>{tel.quota.sqlRows.toLocaleString()} 行</span></div>
                <div className="kv-row"><span className="muted">当前活跃 WebSocket 隧道</span><span>{tel.quota.activeTunnels} 条</span></div>
                <div className="kv-row"><span className="muted">R2 Blob 存储占用</span><span>{bytes(tel.quota.r2Bytes)}</span></div>
              </div>
              {tel.topInstances.length > 0 && (
                <div className="table" style={{ marginTop: 6 }}>
                  <div className="tr t-top th"><span>实例 ID</span><span>请求数</span><span>上下行流量</span></div>
                  {tel.topInstances.slice(0, 4).map(inst => (
                    <div className="tr t-top" key={inst.id}>
                      <code data-label="实例 ID" title={inst.id}>{shortId(inst.id, 14)}</code>
                      <span data-label="请求数">{inst.reqCount}</span>
                      <span data-label="上下行流量" className="muted">{bytes(inst.bytesIn + inst.bytesOut)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="two-col">
        <Card title="接入地址与连接诊断" subtitle="依次检查 HTTP 存活、移动端接口与浏览器到边缘的 WSS 握手；不校验激活码与注册密钥"
          action={<button className="btn-ghost btn-sm" onClick={runDiagnostics} disabled={probing}><Activity size={14} />{probing ? '诊断中…' : '开始诊断'}</button>}>
          <div className="kv-list">
            {[
              ['手机 App 中转地址', origin],
              ['宿主插件隧道 (WSS)', wsUrl],
              ['健康检查端点', origin + '/healthz'],
              ['插件 OTA 检查源 (需附带 ?platform=&channel=)', origin + '/api/desktop-plugins/ota/latest?platform=win32&channel=stable'],
            ].map(([k, v]) => (
              <div className="kv-row" key={k}>
                <span className="muted">{k}</span>
                <div className="kv-val"><code>{v}</code><CopyBtn value={v} label={k} /></div>
              </div>
            ))}
          </div>
          {diagSteps.length > 0 && (
            <div className="stack-xs" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              {diagSteps.map(s => (
                <div className="row-between" key={s.name}>
                  <span className="btn-row small">{s.ok ? <CheckCircle2 size={14} className="ok" /> : <XCircle size={14} className="bad" />}{s.name}</span>
                  <span className="btn-row"><span className="muted small">{s.detail}</span><Badge tone={s.ok ? 'ok' : 'bad'}>{s.ms}ms</Badge></span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="近期操作审计" subtitle="管理员操作记录"
          action={<button className="btn-ghost btn-sm" onClick={() => onNav('audit')}>查看全部</button>}>
          {audit.length === 0 ? <EmptyState title="暂无审计记录" hint="切换模式、生成激活码或踢出隧道后会在此记录" /> : (
            <div className="feed">
              {audit.map(a => (
                <div className="feed-item" key={a.id}>
                  <Badge tone={actionTone(a.action)}>{a.action}</Badge>
                  <span className="feed-target" title={a.target}>{a.target || '—'}</span>
                  <span className="muted small">{ago(a.created)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal open={wizardOpen} title="接入向导" onClose={() => setWizardOpen(false)} width={560}
        footer={<button className="btn-primary" onClick={() => setWizardOpen(false)}>关闭</button>}>
        <div className="form">
          <div className="banner">
            <span>当前中转准入模式：<b>{o.mode === 'restricted' ? '限制模式（必须选择有效激活码）' : '开放模式（激活码可选）'}</b></span>
          </div>
          <label>选择要填入宿主的激活码（可选）
            <select value={selLic} onChange={e => setSelLic(e.target.value)}>
              <option value="">不使用激活码（仅开放模式）</option>
              {licenses.map(l => <option key={l.id} value={l.code}>{l.code}{l.note ? ` · ${l.note}` : ''}</option>)}
            </select>
          </label>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>1. 桌面插件图形界面填入项</div>
            <div className="kv-list">
              <div className="kv-row"><span className="muted">中转地址</span><div className="kv-val"><code>{origin}</code><CopyBtn value={origin} label="中转地址" /></div></div>
              {selLic && <div className="kv-row"><span className="muted">激活码</span><div className="kv-val"><code>{selLic}</code><CopyBtn value={selLic} label="激活码" /></div></div>}
            </div>
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>2. 无头服务器 / CLI 配置方式（配置文件 + 注册密钥环境变量）</div>
            <div className="code-box"><pre>{headlessSnippet}</pre><CopyBtn value={headlessSnippet} label="配置片段" /></div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
