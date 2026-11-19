import { useCallback, useEffect, useState } from 'react'
import { BellRing, Check, Edit3, History, Plus, Send, Search, Trash2, Webhook } from 'lucide-react'
import { api, ago, fmtTime, shortId } from '../api'
import { Badge, BatchBar, Card, ConfirmDialog, Drawer, EmptyState, Modal, Pagination, SortTh, type BadgeTone, type SortState, useToast } from './ui'

const PROVIDERS = [
  { id: 'bark', name: 'Bark (iOS)', tone: 'bad' as BadgeTone, urlPh: 'https://api.day.app/<your-key>', targetLbl: '分组名 (默认 AI-HUB)' },
  { id: 'telegram', name: 'Telegram Bot', tone: 'info' as BadgeTone, urlPh: 'https://api.telegram.org/bot<token>/sendMessage', targetLbl: 'Chat ID (必填)' },
  { id: 'feishu', name: '飞书机器人', tone: 'cyan' as BadgeTone, urlPh: 'https://open.feishu.cn/open-apis/bot/v2/hook/<id>', targetLbl: '备注标签（可选）' },
  { id: 'dingtalk', name: '钉钉机器人', tone: 'accent' as BadgeTone, urlPh: 'https://oapi.dingtalk.com/robot/send?access_token=<tok>', targetLbl: '备注标签（可选）' },
  { id: 'wecom', name: '企业微信', tone: 'ok' as BadgeTone, urlPh: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>', targetLbl: '备注标签（可选）' },
  { id: 'discord', name: 'Discord', tone: 'purple' as BadgeTone, urlPh: 'https://discord.com/api/webhooks/<id>/<token>', targetLbl: 'Bot 显示名 (默认 AI-HUB Relay)' },
  { id: 'custom', name: '自定义 JSON', tone: 'neutral' as BadgeTone, urlPh: 'https://your-server.example/hook', targetLbl: '备注标签（可选）' },
]

const EVENTS = [
  { id: 'push', label: '会话通知 (0x1B 桥接)' },
  { id: 'host.disconnect', label: '宿主意外断线 / 心跳超时' },
  { id: 'plugin.outdated', label: '旧版插件被拦截' },
  { id: 'auth.bruteforce', label: '后台登录爆破限流' },
]

const providerMeta = (id: string) => PROVIDERS.find(p => p.id === id) ?? PROVIDERS[6]

export function WebhooksPanel() {
  const toast = useToast()
  const [items, setItems] = useState<any[]>([])
  const [alerts, setAlerts] = useState({ disconnect: true, bruteforce: true, outdated: true, cooldownSec: 60 })
  const [q, setQ] = useState('')
  const [provFilter, setProvFilter] = useState('all')
  const [sort, setSort] = useState<SortState>({ field: 'created', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Edit / Create Modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', provider: 'bark', url: '', secret: '', clearSecret: false, secretSet: false, target: '', events: ['push', 'host.disconnect'] as string[], enabled: true })
  const [busy, setBusy] = useState(false)

  // Logs drawer & Confirm
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const [delTarget, setDelTarget] = useState<any | null>(null)
  const [batchConfirm, setBatchConfirm] = useState<'delete' | null>(null)
  const [clearLogsConfirm, setClearLogsConfirm] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api<any>('/webhooks')
      setItems(r.items ?? [])
      if (r.alerts) setAlerts(r.alerts)
    } catch (e: any) { toast(e.message, 'error') }
  }, [toast])

  useEffect(() => { load() }, [load])

  const loadLogs = async () => {
    setLogsOpen(true)
    try { setLogs((await api<any>('/webhooks/logs')).items ?? []) }
    catch (e: any) { toast(e.message, 'error') }
  }

  const saveAlerts = async (next: typeof alerts) => {
    const prev = alerts
    const clean = { ...next, cooldownSec: Math.max(10, Math.min(3600, Number(next.cooldownSec) || 60)) }
    setAlerts(clean)
    try { await api('/webhooks/alerts', { method: 'PUT', body: clean }); toast('告警策略已保存', 'success') }
    catch (e: any) { setAlerts(prev); toast(e.message, 'error') }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({ name: '', provider: 'bark', url: '', secret: '', clearSecret: false, secretSet: false, target: '', events: ['push', 'host.disconnect'], enabled: true })
    setModalOpen(true)
  }

  const openEdit = (w: any) => {
    setEditingId(w.id)
    setForm({ name: w.name, provider: w.provider, url: w.url, secret: '', clearSecret: false, secretSet: !!w.secretSet, target: w.target || '', events: w.events ?? ['push'], enabled: w.enabled })
    setModalOpen(true)
  }

  const submit = async () => {
    if (!form.name.trim()) return toast('请输入渠道名称', 'error')
    if (!form.url.trim().startsWith('https://')) return toast('Webhook URL 必须以 https:// 开头', 'error')
    if (form.provider === 'telegram' && !form.target.trim()) return toast('Telegram 渠道必须填写 Chat ID', 'error')
    if (!form.events.length) return toast('请至少订阅一个事件', 'error')
    setBusy(true)
    try {
      const payload = { ...form, secret: form.secret.trim() || undefined }
      if (editingId) await api(`/webhooks/${editingId}`, { method: 'PUT', body: payload })
      else await api('/webhooks', { body: payload })
      toast(editingId ? 'Webhook 已更新' : 'Webhook 已添加', 'success')
      setModalOpen(false)
      load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const testSend = async (w: any) => {
    try {
      const r = await api<any>(`/webhooks/${w.id}/test`, { method: 'POST' })
      toast(r.ok ? `测试发送成功 (${r.latencyMs}ms)` : `发送失败: ${r.error}`, r.ok ? 'success' : 'error')
    } catch (e: any) { toast(e.message, 'error') }
  }

  const runBatch = async (action: 'enable' | 'disable' | 'delete') => {
    setBusy(true)
    try {
      await api('/webhooks/batch', { body: { ids: [...selectedIds], action } })
      toast('批量操作完成', 'success')
      setSelectedIds(new Set()); setBatchConfirm(null); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const filtered = items
    .filter(w => provFilter === 'all' || w.provider === provFilter)
    .filter(w => !q.trim() || `${w.name} ${w.url} ${w.provider}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => {
      const m = sort.dir === 'asc' ? 1 : -1
      const va = a[sort.field] ?? '', vb = b[sort.field] ?? ''
      return typeof va === 'number' && typeof vb === 'number' ? (va - vb) * m : String(va).localeCompare(String(vb)) * m
    })

  const pageSize = 8
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const meta = providerMeta(form.provider)

  return (
    <div className="stack">
      <Card title="运维告警策略" subtitle="触发后将按渠道订阅自动推送；同一实例/IP 在冷却时间内不会重复刷屏">
        <div className="chk-grid">
          <label className="chk-row"><input type="checkbox" checked={alerts.disconnect} onChange={e => saveAlerts({ ...alerts, disconnect: e.target.checked })} />宿主意外断线 / 心跳超时</label>
          <label className="chk-row"><input type="checkbox" checked={alerts.outdated} onChange={e => saveAlerts({ ...alerts, outdated: e.target.checked })} />旧版插件拦截告警</label>
          <label className="chk-row"><input type="checkbox" checked={alerts.bruteforce} onChange={e => saveAlerts({ ...alerts, bruteforce: e.target.checked })} />登录爆破限流告警</label>
          <div className="btn-row">
            <span className="muted small">冷却(秒)</span>
            <input type="number" min={10} max={3600} value={alerts.cooldownSec} onChange={e => setAlerts({ ...alerts, cooldownSec: +e.target.value })} style={{ width: 82 }} />
            <button className="btn-ghost btn-sm" onClick={() => saveAlerts(alerts)}><Check size={13} />应用</button>
          </div>
        </div>
      </Card>

      <Card title="Webhook 推送渠道 (7 平台适配)" subtitle="收到宿主 0x1B pushSend 或运维告警时同步转发（支持 Bark / Telegram / 飞书 / 钉钉 / 企微 / Discord / 自定义）"
        action={
          <div className="btn-row">
            <button className="btn-ghost" onClick={loadLogs}><History size={14} />投递日志</button>
            <button className="btn-primary" onClick={openCreate}><Plus size={14} />添加渠道</button>
          </div>
        }>
        <div className="toolbar">
          <div className="search-box">
            <Search size={14} className="muted" />
            <input placeholder="按名称 / URL 搜索…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
          </div>
          <select style={{ width: 160 }} value={provFilter} onChange={e => { setProvFilter(e.target.value); setPage(1) }}>
            <option value="all">全部渠道</option>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <BatchBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('enable')}>批量启用</button>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('disable')}>批量停用</button>
          <button className="btn-ghost btn-sm danger" onClick={() => setBatchConfirm('delete')}>批量删除</button>
        </BatchBar>

        {paged.length === 0 ? (
          <EmptyState icon={<Webhook size={24} />}
            title={items.length === 0 ? '尚未配置 Webhook 推送渠道' : '没有匹配的 Webhook 渠道'}
            hint={items.length === 0 ? '自建用户无需官方 iOS .p8 密钥，配好 Bark 或 Telegram 即可实现锁屏任务提醒' : '请调整筛选条件'} />
        ) : (
          <div className="table">
            <div className="tr t-wh th">
              <input type="checkbox" checked={paged.length > 0 && paged.every(w => selectedIds.has(w.id))}
                onChange={e => setSelectedIds(e.target.checked ? new Set(paged.map(w => w.id)) : new Set())} />
              <SortTh label="名称" field="name" sort={sort} onSort={setSort} />
              <SortTh label="渠道" field="provider" sort={sort} onSort={setSort} />
              <span>Webhook 地址</span>
              <span>订阅</span>
              <SortTh label="状态" field="enabled" sort={sort} onSort={setSort} />
              <span />
            </div>
            {paged.map(w => {
              const pm = providerMeta(w.provider)
              return (
                <div className="tr t-wh" key={w.id}>
                  <label className="chk-row" data-label="选择">
                    <input type="checkbox" checked={selectedIds.has(w.id)} onChange={e => {
                      const n = new Set(selectedIds); e.target.checked ? n.add(w.id) : n.delete(w.id); setSelectedIds(n)
                    }} />
                  </label>
                  <span data-label="名称"><b>{w.name}</b></span>
                  <span data-label="渠道"><Badge tone={pm.tone}>{pm.name}</Badge></span>
                  <code data-label="地址" className="muted" title={w.url}>{shortId(w.url, 34)}</code>
                  <span data-label="订阅"><Badge>{(w.events ?? []).length} 项</Badge></span>
                  <span data-label="状态">{w.enabled ? <Badge tone="ok" dot>启用</Badge> : <Badge>停用</Badge>}</span>
                  <span className="actions">
                    <button className="icon-btn" title="发送测试" onClick={() => testSend(w)}><Send size={14} /></button>
                    <button className="icon-btn" title="编辑" onClick={() => openEdit(w)}><Edit3 size={14} /></button>
                    <button className="icon-btn danger" title="删除" onClick={() => setDelTarget(w)}><Trash2 size={14} /></button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
        <Pagination total={filtered.length} page={safePage} pageSize={pageSize} onChange={setPage} />
      </Card>

      <Modal open={modalOpen} title={editingId ? '编辑 Webhook 渠道' : '添加 Webhook 渠道'} onClose={() => setModalOpen(false)} width={520} footer={
        <>
          <button className="btn-ghost" onClick={() => setModalOpen(false)}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '保存中…' : '保存渠道'}</button>
        </>
      }>
        <div className="form">
          <div className="form-2">
            <label>渠道名称<input placeholder="例如：我的 iPhone Bark" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
            <label>平台类型
              <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
                {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>
          <label>HTTPS Webhook URL<input placeholder={meta.urlPh} value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} /></label>
          <div className="form-2">
            <label>{meta.targetLbl}<input value={form.target} onChange={e => setForm({ ...form, target: e.target.value })} placeholder={form.provider === 'telegram' ? '-100123456' : ''} /></label>
            <label>签名 Secret（飞书/钉钉/自定义可选）
              <input type="password" disabled={form.clearSecret} value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} placeholder={editingId && form.secretSet ? '已设置（留空保留）' : '可选'} />
            </label>
          </div>
          {editingId && form.secretSet && (
            <label className="chk-row"><input type="checkbox" checked={form.clearSecret} onChange={e => setForm({ ...form, clearSecret: e.target.checked, secret: '' })} />清除已保存的 Secret</label>
          )}
          <div>
            <div className="small muted" style={{ marginBottom: 6 }}>订阅事件</div>
            <div className="chk-grid">
              {EVENTS.map(ev => (
                <label className="chk-row" key={ev.id}>
                  <input type="checkbox" checked={form.events.includes(ev.id)} onChange={e => {
                    const next = e.target.checked ? [...form.events, ev.id] : form.events.filter(x => x !== ev.id)
                    setForm({ ...form, events: next })
                  }} />
                  {ev.label}
                </label>
              ))}
            </div>
          </div>
          <label className="chk-row"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用此渠道</label>
        </div>
      </Modal>

      <Drawer open={logsOpen} title="Webhook 投递日志" subtitle="最近 150 条推送与告警记录" onClose={() => setLogsOpen(false)}>
        <div className="stack-sm">
          {logs.length > 0 && (
            <div className="row-between">
              <span className="muted small">共 {logs.length} 条记录</span>
              <button className="btn-ghost btn-sm danger" onClick={() => setClearLogsConfirm(true)}>清空日志</button>
            </div>
          )}
          {logs.length === 0 ? <EmptyState icon={<BellRing size={22} />} title="暂无投递记录" /> : logs.map(l => (
            <div className="dev-card" key={l.id}>
              <div style={{ minWidth: 0 }}>
                <div className="btn-row">
                  <Badge tone={l.ok ? 'ok' : 'bad'}>{l.ok ? `成功 ${l.status}` : `失败 ${l.status || 'ERR'}`}</Badge>
                  <Badge tone={providerMeta(l.provider).tone}>{l.webhookName}</Badge>
                  <span className="muted small">{l.latencyMs}ms</span>
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>{l.event} · {fmtTime(l.created)}</div>
                {l.error && <div className="bad small" style={{ marginTop: 3 }}>{l.error}</div>}
              </div>
            </div>
          ))}
        </div>
      </Drawer>

      <ConfirmDialog open={!!delTarget} danger busy={busy} title="删除 Webhook 渠道"
        description={`确定删除「${delTarget?.name}」吗？`} confirmText="确认删除"
        onCancel={() => setDelTarget(null)}
        onConfirm={async () => {
          setBusy(true)
          try {
            await api(`/webhooks/${delTarget.id}`, { method: 'DELETE' })
            toast('已删除', 'success')
            setSelectedIds(prev => { const n = new Set(prev); n.delete(delTarget.id); return n })
            setDelTarget(null); load()
          } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />

      <ConfirmDialog open={clearLogsConfirm} danger busy={busy} title="清空投递日志"
        description="确定清空全部 Webhook 投递记录吗？" confirmText="确认清空"
        onCancel={() => setClearLogsConfirm(false)}
        onConfirm={async () => {
          setBusy(true)
          try { await api('/webhooks/logs', { method: 'DELETE' }); setLogs([]); setClearLogsConfirm(false); toast('已清空日志', 'success') }
          catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />

      <ConfirmDialog open={!!batchConfirm} danger busy={busy} title="批量删除 Webhook"
        description={`确定删除选中的 ${selectedIds.size} 个 Webhook 渠道吗？`} confirmText="确认删除"
        onCancel={() => setBatchConfirm(null)} onConfirm={() => runBatch('delete')} />
    </div>
  )
}
