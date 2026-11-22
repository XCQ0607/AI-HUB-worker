import { useCallback, useEffect, useState } from 'react'
import { Bell, Database, HardDrive, RefreshCw, Search, Send, Trash2 } from 'lucide-react'
import { api, ago, bytes, shortId } from '../api'
import { Badge, Card, ConfirmDialog, EmptyState, Modal, Pagination, platformTone, ProgressBar, useToast } from '../components/ui'
import { WebhooksPanel } from '../components/WebhooksPanel'

export function Storage() {
  const toast = useToast()
  const [sub, setSub] = useState<'mirror' | 'blobs' | 'push' | 'webhooks'>('mirror')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 15
  const [mirror, setMirror] = useState<any>(null)
  const [blobs, setBlobs] = useState<any>(null)
  const [push, setPush] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [errs, setErrs] = useState<{ mirror?: string; blobs?: string; push?: string }>({})
  const [fallbackMs, setFallbackMs] = useState('0')
  const [confirmClear, setConfirmClear] = useState<{ kind: 'mirror' | 'blobs' | 'push'; instance?: string; deviceId?: string } | null>(null)
  const [testPush, setTestPush] = useState<{ instance: string; deviceId: string } | null>(null)
  const [pushTitle, setPushTitle] = useState('AI-HUB 测试推送')
  const [pushBody, setPushBody] = useState('这是一条来自中转控制台的 APNs 推送测试消息')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [m, b, p] = await Promise.allSettled([api<any>('/mirror'), api<any>('/blobs'), api<any>('/push/tokens')])
    const nextErrs: { mirror?: string; blobs?: string; push?: string } = {}
    if (m.status === 'fulfilled') {
      setMirror(m.value)
      setFallbackMs(String(m.value.fallbackMs ?? 0))
    } else {
      nextErrs.mirror = m.reason?.message || '读取离线镜像失败'
    }
    if (b.status === 'fulfilled') {
      setBlobs(b.value)
    } else {
      nextErrs.blobs = b.reason?.message || '读取 R2 密文列表失败'
    }
    if (p.status === 'fulfilled') {
      setPush(p.value)
    } else {
      nextErrs.push = p.reason?.message || '读取 APNs 令牌失败'
    }
    setErrs(nextErrs)
    const errMsgs = Object.values(nextErrs)
    if (errMsgs.length > 0) toast(errMsgs[0], 'error')
    setLoading(false)
  }, [toast])

  useEffect(() => { load() }, [load])

  const toggleMirror = async () => {
    if (!mirror) return
    try {
      await api('/settings', { method: 'PUT', body: { mirrorEnabled: !mirror.enabled } })
      toast(!mirror.enabled ? '已开启离线镜像兜底' : '已关闭离线镜像兜底（仍保留凭据摘要）', 'success')
      load()
    } catch (e: any) { toast(e.message, 'error') }
  }

  const saveFallback = async () => {
    try {
      await api('/settings', { method: 'PUT', body: { mirrorFallbackMs: Number(fallbackMs) || 0 } })
      toast('已保存慢隧道回退阈值', 'success')
      load()
    } catch (e: any) { toast(e.message, 'error') }
  }

  const runClear = async () => {
    if (!confirmClear) return
    setBusy(true)
    try {
      if (confirmClear.kind === 'mirror') {
        await api(confirmClear.instance ? `/mirror/${encodeURIComponent(confirmClear.instance)}` : '/mirror', { method: 'DELETE' })
      } else if (confirmClear.kind === 'blobs') {
        await api(confirmClear.instance ? `/blobs/${encodeURIComponent(confirmClear.instance)}` : '/blobs', { method: 'DELETE' })
      } else if (confirmClear.instance && confirmClear.deviceId) {
        await api(`/push/tokens/${encodeURIComponent(confirmClear.instance)}/${encodeURIComponent(confirmClear.deviceId)}`, { method: 'DELETE' })
      }
      toast('已清理', 'success')
      setConfirmClear(null)
      load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const sendTest = async () => {
    if (!testPush) return
    setBusy(true)
    try {
      const r = await api<any>('/push/test', { body: { ...testPush, title: pushTitle, body: pushBody } })
      toast(`推送完成：成功 ${r.sent}，失败 ${r.failed}`, r.failed ? 'error' : 'success')
      setTestPush(null)
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="seg">
          <button className={sub === 'mirror' ? 'active' : ''} onClick={() => { setSub('mirror'); setPage(1); setQ('') }}>离线镜像 (Mirror)</button>
          <button className={sub === 'blobs' ? 'active' : ''} onClick={() => { setSub('blobs'); setPage(1); setQ('') }}>R2 历史密文 (Blob)</button>
          <button className={sub === 'push' ? 'active' : ''} onClick={() => { setSub('push'); setPage(1); setQ('') }}>iOS APNs 推送</button>
          <button className={sub === 'webhooks' ? 'active' : ''} onClick={() => { setSub('webhooks'); setPage(1); setQ('') }}>Webhook 推送与告警</button>
        </div>
        <button className="icon-btn" onClick={load} title="刷新" aria-label="刷新存储与推送数据"><RefreshCw size={14} /></button>
      </div>
      {sub !== 'webhooks' && (
        <div className="banner">
          <span className="small">
            <b>三类数据区别：</b>
            <b>离线镜像</b>（DO SQLite）缓存最近一次会话/工作区清单供断线兜底；
            <b>R2 历史密文</b>（Cloudflare R2）存放宿主端到端加密的历史消息与文件密文（中转不持钥、7 天自动淘汰）；
            <b>APNs 推送令牌</b>仅记录已配对 iOS 设备的推送凭据，用于锁屏提醒。
          </span>
        </div>
      )}
      {sub !== 'webhooks' && (
        <div className="toolbar">
          <div className="search-box">
            <Search size={14} className="muted" />
            <input placeholder="按实例 ID / 设备 ID 过滤…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
          </div>
        </div>
      )}

      {sub === 'mirror' && (
        loading && !mirror ? <p className="muted pad">正在加载离线镜像数据…</p> : !mirror ? (
          <Card title="离线镜像兜底 (0x17 sync)">
            <EmptyState icon={<HardDrive size={22} />} title="加载离线镜像失败" hint={errs.mirror} action={<button className="btn-ghost btn-sm" onClick={load}>重试</button>} />
          </Card>
        ) : (
        <Card title="离线镜像兜底 (0x17 sync)" subtitle="宿主断线时，向已配对手机返回带 stale 标记的会话/工作区清单"
          action={
            <div className="btn-row">
              <button className="btn-ghost" onClick={toggleMirror}>{mirror.enabled ? '停用正文缓存' : '启用离线镜像'}</button>
              {mirror.items.length > 0 && <button className="btn-ghost danger" onClick={() => setConfirmClear({ kind: 'mirror' })}>清空全部</button>}
            </div>
          }>
          <div className="mirror-meta">
            <div className="stack-xs" style={{ flex: 1 }}>
              <div className="row-between">
                <span>缓存占用：{bytes(mirror.bytes)} / {bytes(mirror.budget)}（{mirror.instances} 个实例）</span>
                <Badge tone={mirror.enabled ? 'ok' : 'neutral'}>{mirror.enabled ? '已开启' : '仅保留凭据摘要'}</Badge>
              </div>
              <ProgressBar value={mirror.bytes} max={mirror.budget} />
            </div>
            <div className="btn-row">
              <input type="number" min={0} max={30000} aria-label="慢隧道回退阈值毫秒" value={fallbackMs} onChange={e => setFallbackMs(e.target.value)} style={{ width: 110 }} placeholder="0" />
              <button className="btn-primary btn-sm" onClick={saveFallback}>保存超时回退(ms)</button>
            </div>
          </div>

          {mirror.items.length === 0 ? <EmptyState icon={<HardDrive size={22} />} title="暂无镜像快照" hint="宿主插件上线后会自动通过 0x17 帧同步清单与凭据摘要" /> : (() => {
            const list = mirror.items.filter((m: any) => !q.trim() || String(m.instance).toLowerCase().includes(q.trim().toLowerCase()))
            const cur = Math.min(page, Math.max(1, Math.ceil(list.length / pageSize)))
            const paged = list.slice((cur - 1) * pageSize, cur * pageSize)
            return paged.length === 0 ? <EmptyState icon={<HardDrive size={22} />} title="无匹配镜像" /> : (
              <>
                <div className="table">
                  <div className="tr t-mir th"><span>实例 ID</span><span>会话 Rev</span><span>凭据数</span><span>大小</span><span>更新时间</span><span /></div>
                  {paged.map((m: any) => (
                    <div className="tr t-mir" key={m.instance}>
                      <code data-label="实例 ID" title={m.instance}>{shortId(m.instance, 24)}</code>
                      <code className="muted" data-label="会话 Rev">{m.sessionsRev || '—'}</code>
                      <span data-label="凭据数">{m.credsCount}</span>
                      <span data-label="大小">{bytes(m.bytes)}</span>
                      <span className="muted" data-label="更新时间">{ago(m.updated)}</span>
                      <span className="actions"><button className="icon-btn danger" title="清理镜像" aria-label={`清理实例 ${m.instance} 的镜像`} onClick={() => setConfirmClear({ kind: 'mirror', instance: m.instance })}><Trash2 size={14} /></button></span>
                    </div>
                  ))}
                </div>
                <Pagination page={cur} pageSize={pageSize} total={list.length} onChange={setPage} />
              </>
            )
          })()}
        </Card>
        )
      )}

      {sub === 'blobs' && (
        loading && !blobs ? <p className="muted pad">正在加载 R2 密文数据…</p> : !blobs ? (
          <Card title="R2 历史密文存储 (0x1D / 0x1E)">
            <EmptyState icon={<Database size={22} />} title="加载 R2 密文列表失败" hint={errs.blobs} action={<button className="btn-ghost btn-sm" onClick={load}>重试</button>} />
          </Card>
        ) : (
        <Card title="R2 历史密文存储 (0x1D / 0x1E)" subtitle="仅保存宿主用实例历史密钥加密后的密文，7 天自动淘汰，中转不持钥、不解密"
          action={<div className="btn-row">
            <Badge tone={blobs.enabled ? 'ok' : 'warn'}>{blobs.enabled ? 'R2 已绑定' : '未绑定 R2'}</Badge>
            {blobs.items.length > 0 && <button className="btn-ghost danger" onClick={() => setConfirmClear({ kind: 'blobs' })}>清空全部</button>}
          </div>}>
          {!blobs.enabled ? <EmptyState icon={<Database size={22} />} title="尚未绑定 Cloudflare R2 存储桶" hint="部署时设置 ENABLE_R2=1 即可自动创建并绑定 ai-hub-blob 桶" />
            : blobs.items.length === 0 ? <EmptyState icon={<Database size={22} />} title="暂无密文记录" hint="宿主推送历史会话或文件密文后会按实例显示在此" /> : (() => {
              const list = blobs.items.filter((b: any) => !q.trim() || String(b.instance).toLowerCase().includes(q.trim().toLowerCase()))
              const cur = Math.min(page, Math.max(1, Math.ceil(list.length / pageSize)))
              const paged = list.slice((cur - 1) * pageSize, cur * pageSize)
              return paged.length === 0 ? <EmptyState icon={<Database size={22} />} title="无匹配密文" /> : (
                <>
                  <div className="table">
                    <div className="tr t-blob th"><span>实例 ID</span><span>条数</span><span>占用空间</span><span>最近写入</span><span /></div>
                    {paged.map((b: any) => (
                      <div className="tr t-blob" key={b.instance}>
                        <code data-label="实例 ID" title={b.instance}>{shortId(b.instance, 26)}</code>
                        <span data-label="条数">{b.count}</span>
                        <span data-label="占用空间">{bytes(b.bytes)}</span>
                        <span className="muted" data-label="最近写入">{ago(b.updated)}</span>
                        <span className="actions"><button className="icon-btn danger" title="清理密文" aria-label={`清理实例 ${b.instance} 的密文`} onClick={() => setConfirmClear({ kind: 'blobs', instance: b.instance })}><Trash2 size={14} /></button></span>
                      </div>
                    ))}
                  </div>
                  <Pagination page={cur} pageSize={pageSize} total={list.length} onChange={setPage} />
                </>
              )
            })()}
        </Card>
        )
      )}

      {sub === 'push' && (
        loading && !push ? <p className="muted pad">正在加载 APNs 推送令牌…</p> : !push ? (
          <Card title="iOS APNs 离线推送">
            <EmptyState icon={<Bell size={22} />} title="加载 APNs 令牌失败" hint={errs.push} action={<button className="btn-ghost btn-sm" onClick={load}>重试</button>} />
          </Card>
        ) : (
        <Card title="iOS APNs 离线推送" subtitle="手机锁屏时接收会话完成与审批提醒"
          action={<Badge tone={push.enabled ? 'ok' : 'warn'}>{push.enabled ? 'APNs 密钥已配置' : '未配置 APNS_* 密钥'}</Badge>}>
          {push.items.length === 0 ? <EmptyState icon={<Bell size={22} />} title="暂无设备推送令牌" hint="手机 App 配对并授权通知权限后会自动上报令牌" /> : (() => {
            const list = push.items.filter((p: any) => !q.trim() || `${p.instance} ${p.deviceId}`.toLowerCase().includes(q.trim().toLowerCase()))
            const cur = Math.min(page, Math.max(1, Math.ceil(list.length / pageSize)))
            const paged = list.slice((cur - 1) * pageSize, cur * pageSize)
            return paged.length === 0 ? <EmptyState icon={<Bell size={22} />} title="无匹配设备令牌" /> : (
              <>
                <div className="table">
                  <div className="tr t-push th"><span>实例 ID</span><span>设备 ID</span><span>平台</span><span>令牌摘要</span><span>更新时间</span><span /></div>
                  {paged.map((p: any) => (
                    <div className="tr t-push" key={`${p.instance}-${p.deviceId}`}>
                      <code data-label="实例 ID" title={p.instance}>{shortId(p.instance, 20)}</code>
                      <code data-label="设备 ID" title={p.deviceId}>{shortId(p.deviceId, 18)}</code>
                      <span data-label="平台"><Badge tone={platformTone(p.platform)}>{p.platform}</Badge></span>
                      <code className="muted" data-label="令牌摘要">{p.tokenPreview}</code>
                      <span className="muted" data-label="更新时间">{ago(p.updated)}</span>
                      <span className="actions">
                        <button className="icon-btn" title="发送测试推送" aria-label={`向设备 ${p.deviceId} 发送测试推送`} disabled={!push.enabled} onClick={() => setTestPush({ instance: p.instance, deviceId: p.deviceId })}><Send size={14} /></button>
                        <button className="icon-btn danger" title="删除令牌" aria-label={`删除设备 ${p.deviceId} 的推送令牌`} onClick={() => setConfirmClear({ kind: 'push', instance: p.instance, deviceId: p.deviceId })}><Trash2 size={14} /></button>
                      </span>
                    </div>
                  ))}
                </div>
                <Pagination page={cur} pageSize={pageSize} total={list.length} onChange={setPage} />
              </>
            )
          })()}
        </Card>
        )
      )}

      {sub === 'webhooks' && <WebhooksPanel />}

      <Modal open={!!testPush} title="发送 APNs 测试推送" onClose={() => setTestPush(null)} footer={
        <>
          <button className="btn-ghost" onClick={() => setTestPush(null)}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={sendTest}>{busy ? '发送中…' : '立即发送'}</button>
        </>
      }>
        <div className="form">
          <label>通知标题<input value={pushTitle} onChange={e => setPushTitle(e.target.value)} /></label>
          <label>通知正文<input value={pushBody} onChange={e => setPushBody(e.target.value)} /></label>
        </div>
      </Modal>

      <ConfirmDialog open={!!confirmClear} danger busy={busy} title="确认清理"
        description={confirmClear?.kind === 'push' ? '确定移除该设备的 APNs 推送令牌吗？' : '确定清理选中的缓存/存储数据吗？此操作不可撤销。'}
        confirmText="确认清理" onCancel={() => setConfirmClear(null)} onConfirm={runClear} />
    </div>
  )
}
