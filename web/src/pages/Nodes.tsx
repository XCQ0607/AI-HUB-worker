import { useCallback, useEffect, useState } from 'react'
import { Network, Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-react'
import { api, ago, fmtTime } from '../api'
import { Badge, Card, ConfirmDialog, CopyBtn, EmptyState, Modal, useToast } from '../components/ui'

export function Nodes() {
  const toast = useToast()
  const [ov, setOv] = useState<any>(null)
  const [nodes, setNodes] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'revoked'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [nodeName, setNodeName] = useState('')
  const [createdClaim, setCreatedClaim] = useState('')
  const [confirmAct, setConfirmAct] = useState<{ kind: 'revoke' | 'forget'; node: any } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const o = await api<any>('/overview')
      if (o.role === 'master') {
        const n = await api<{ items: any[] }>('/nodes')
        setNodes(n.items)
      }
      setOv(o)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ claimCode: string }>('/nodes', { body: { name: nodeName } })
      setCreatedClaim(r.claimCode)
      toast('已生成节点认领码', 'success')
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const setDesired = async (node: any, mode: 'open' | 'restricted' | 'auto') => {
    try {
      await api(`/nodes/${node.id}/mode`, { method: 'POST', body: { mode } })
      toast(mode === 'auto' ? '已交还被控端自主管理' : `已下发期望模式：${mode === 'open' ? '开放' : '限制'}`, 'success')
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  if (!ov) return <p className="muted pad">加载中…</p>

  if (ov.role === 'slave') {
    return (
      <Card title="本节点运行于被控模式 (Slave)" subtitle="按周期向主控端上报本机摘要，并接收准入模式指令">
        <div className="kv-list">
          <div className="kv-row"><span className="muted">主控端地址</span><code>{ov.masterUrl}</code></div>
          <div className="kv-row"><span className="muted">上报周期</span><span>每 {Math.round((ov.reportIntervalSeconds || 300) / 60)} 分钟</span></div>
          <div className="kv-row"><span className="muted">最近上报</span><span>{ov.masterLastReportAt ? fmtTime(ov.masterLastReportAt) : '尚未上报成功'}</span></div>
          <div className="kv-row"><span className="muted">准入控制权</span>{ov.modeControlled ? <Badge tone="warn">由主控端接管</Badge> : <Badge tone="ok">本地自主控制</Badge>}</div>
          {ov.masterLastError && <div className="kv-row"><span className="muted">最近错误</span><span className="bad">{ov.masterLastError}</span></div>}
        </div>
      </Card>
    )
  }

  return (
    <div className="stack">
      <Card title="节点联邦" subtitle="用认领码把其它中转挂到这里，集中查看状态、统一下发准入模式"
        action={
          <div className="btn-row">
            <button className="icon-btn" onClick={load} title="刷新" aria-label="刷新节点列表"><RefreshCw size={14} /></button>
            <button className="btn-primary" onClick={() => { setCreatedClaim(''); setNodeName(''); setCreateOpen(true) }}>
              <Plus size={14} />生成认领码
            </button>
          </div>
        }>
        {nodes.length === 0 ? (
          <EmptyState icon={<Network size={24} />} title="暂无被控端节点" hint="如果只部署了单台中转，不需要配置此项" />
        ) : (() => {
          const filtered = nodes
            .filter(n => statusFilter === 'all' || (statusFilter === 'online' ? n.tunnelOnline && !n.revokedAt : statusFilter === 'offline' ? !n.tunnelOnline && !n.revokedAt : !!n.revokedAt))
            .filter(n => !q.trim() || `${n.name} ${n.claimCode} ${n.publicUrl}`.toLowerCase().includes(q.trim().toLowerCase()))
          return (
            <>
              <div className="toolbar">
                <div className="search-box">
                  <Search size={14} className="muted" />
                  <input placeholder="搜索节点名称 / 认领码 / 公网地址…" value={q} onChange={e => setQ(e.target.value)} />
                </div>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={{ width: 130 }}>
                  <option value="all">全部状态</option>
                  <option value="online">有宿主在线</option>
                  <option value="offline">暂无宿主</option>
                  <option value="revoked">已移除</option>
                </select>
              </div>
              {filtered.length === 0 ? <EmptyState icon={<Network size={22} />} title="无匹配节点" /> : (
                <div className="node-grid">
                  {filtered.map(n => {
              const desired = n.desiredMode === 'open' || n.desiredMode === 'restricted' ? n.desiredMode : null
              const pending = desired && desired !== n.admissionMode
              return (
                <div className="node-card" key={n.id}>
                  <div className="node-hd">
                    <div className="node-title">
                      <Server size={16} className="muted" />
                      <b>{n.name || '未报到节点'}</b>
                      {n.revokedAt && <Badge tone="bad">已移除</Badge>}
                    </div>
                    {n.tunnelOnline ? <Badge tone="ok" dot>有宿主在线</Badge> : <Badge>暂无宿主</Badge>}
                  </div>

                  <div className="mono-cell"><code>{n.claimCode}</code><CopyBtn value={n.claimCode} label="认领码" /></div>
                  <div className="muted small">地址：{n.publicUrl || '—'} · 码 {n.licenseCount} · 设备 {n.deviceCount} · 上报 {ago(n.lastSeenAt)}</div>

                  {!n.revokedAt ? (
                    <div className="node-ft">
                      <div className="small">
                        当前：<b>{n.admissionMode === 'restricted' ? '限制' : '开放'}</b>
                        {' · '}期望：<span className={pending ? 'warn' : 'muted'}>{desired ? (desired === 'restricted' ? '限制' : '开放') : '自管'}{pending ? ' (待同步)' : ''}</span>
                      </div>
                      <div className="btn-row">
                        <button className="btn-ghost btn-sm" onClick={() => setDesired(n, 'open')}>开放</button>
                        <button className="btn-ghost btn-sm" onClick={() => setDesired(n, 'restricted')}>限制</button>
                        <button className="btn-ghost btn-sm" onClick={() => setDesired(n, 'auto')}>交还</button>
                        <button className="icon-btn danger" title="移除节点" aria-label={`移除节点 ${n.name || n.claimCode}`} onClick={() => setConfirmAct({ kind: 'revoke', node: n })}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="node-ft">
                      <span className="muted small">已于 {ago(n.revokedAt)} 移除（上报将返回 403）</span>
                      <button className="btn-ghost btn-sm danger" onClick={() => setConfirmAct({ kind: 'forget', node: n })}>彻底清理</button>
                    </div>
                  )}
                </div>
              )
            })}
                </div>
              )}
            </>
          )
        })()}
      </Card>

      <Modal open={createOpen} title="生成节点认领码" onClose={() => setCreateOpen(false)} width={480}
        footer={createdClaim ? <button className="btn-primary" onClick={() => setCreateOpen(false)}>完成</button> : (
          <>
            <button className="btn-ghost" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={create}>{busy ? '生成中…' : '生成'}</button>
          </>
        )}>
        {createdClaim ? (() => {
          const snippet = [
            `"PLATFORM_MASTER_URL": "${location.origin}",`,
            `"PLATFORM_CLAIM_CODE": "${createdClaim}",`,
            `"PLATFORM_MASTER_TOKEN": "", // 若主控端配置了 PLATFORM_MASTER_TOKEN，请填写一致的密钥`,
            `"PLATFORM_NODE_NAME": "${nodeName.trim() || 'slave-node'}",`,
            `"PUBLIC_BASE_URL": "https://your-slave-relay.example.com",`,
            `"PLATFORM_REPORT_INTERVAL_SECONDS": "300"`,
          ].join('\n')
          return (
            <div className="stack-sm">
              <p className="muted">请将以下配置写入被控端中转的 <code>env.json</code>（或 Wrangler 环境变量）并重新部署：</p>
              <div className="code-box">
                <pre>{snippet}</pre>
                <CopyBtn value={snippet} label="配置片段" />
              </div>
              <p className="muted small">提示：被控端按 <code>PLATFORM_REPORT_INTERVAL_SECONDS</code>（默认 300 秒）周期上报，下发准入模式指令可能存在最多 1 个上报周期的同步延迟。</p>
            </div>
          )
        })() : (
          <div className="form">
            <label>节点备注名称（可选）<input placeholder="例如：东京备用节点" value={nodeName} onChange={e => setNodeName(e.target.value)} /></label>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!confirmAct} danger busy={busy}
        title={confirmAct?.kind === 'revoke' ? '移除被控节点' : '彻底删除节点记录'}
        description={confirmAct?.kind === 'revoke'
          ? `移除后节点 ${confirmAct.node.claimCode} 再上报会收到 403 拒绝。`
          : `确定彻底删除节点 ${confirmAct?.node?.claimCode} 的历史记录吗？`}
        confirmText={confirmAct?.kind === 'revoke' ? '移除' : '彻底删除'}
        onCancel={() => setConfirmAct(null)}
        onConfirm={async () => {
          setBusy(true)
          try {
            const u = confirmAct!.kind === 'revoke' ? `/nodes/${confirmAct!.node.id}` : `/nodes/${confirmAct!.node.id}/forget`
            await api(u, { method: 'DELETE' })
            toast('操作完成', 'success')
            setConfirmAct(null)
            load()
          } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />
    </div>
  )
}
