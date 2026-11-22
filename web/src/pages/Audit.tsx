import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw, ScrollText, Search } from 'lucide-react'
import { api, fmtTime } from '../api'
import { actionTone, Badge, Card, EmptyState, Pagination, SortState, SortTh, useToast } from '../components/ui'

export function Audit() {
  const toast = useToast()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [sort, setSort] = useState<SortState>({ field: 'created', dir: 'desc' })
  const [page, setPage] = useState(1)
  const pageSize = 20

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: any[] }>('/audit')
      setItems(r.items)
    } catch (e: any) { toast(e.message, 'error') } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])

  const filtered = items
    .filter(a => cat === 'all' || String(a.action).startsWith(cat))
    .filter(a => !q.trim() || `${a.action} ${a.actor} ${a.target} ${a.detail}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => {
      const m = sort.dir === 'asc' ? 1 : -1
      if (sort.field === 'created') return (a.created - b.created) * m
      return String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? '')) * m
    })

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const paged = filtered.slice((curPage - 1) * pageSize, curPage * pageSize)

  const csvCell = (v: unknown) => {
    const raw = String(v ?? '')
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replace(/"/g, '""')}"`
  }

  const exportFile = (fmt: 'csv' | 'json') => {
    const content = fmt === 'json'
      ? JSON.stringify(filtered, null, 2)
      : '\uFEFF' + ['id,action,actor,target,detail,created', ...filtered.map(a =>
          [a.id, a.action, a.actor, a.target, a.detail, new Date(a.created).toISOString()]
            .map(csvCell).join(','),
        )].join('\n')
    const blob = new Blob([content], { type: fmt === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const el = document.createElement('a')
    el.href = url; el.download = `ai-hub-audit.${fmt}`; el.click()
    URL.revokeObjectURL(url)
    toast(`已导出 ${filtered.length} 条审计日志 (${fmt.toUpperCase()})`, 'success')
  }

  return (
    <Card title="操作审计日志" subtitle="保留最近 200 条管理、登录与准入变更记录"
      action={
        <div className="btn-row">
          <button className="btn-ghost btn-sm" disabled={!filtered.length} onClick={() => exportFile('csv')}><Download size={14} />CSV</button>
          <button className="btn-ghost btn-sm" disabled={!filtered.length} onClick={() => exportFile('json')}><Download size={14} />JSON</button>
          <button className="icon-btn" onClick={load} title="刷新" aria-label="刷新审计日志"><RefreshCw size={14} /></button>
        </div>
      }>
      <div className="toolbar">
        <div className="search-box">
          <Search size={14} className="muted" />
          <input placeholder="按动作 / 操作人 / 目标过滤…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
        </div>
        <select value={cat} onChange={e => { setCat(e.target.value); setPage(1) }} style={{ width: 150 }}>
          <option value="all">全部类别</option>
          <option value="auth.">登录与 2FA</option>
          <option value="admin.">管理员账号</option>
          <option value="license.">激活码</option>
          <option value="device.">设备绑定</option>
          <option value="tunnel.">隧道连接</option>
          <option value="instance.">宿主实例</option>
          <option value="migration.">迁移台账</option>
          <option value="mirror.">离线镜像</option>
          <option value="blob.">R2 密文</option>
          <option value="push.">APNs 推送</option>
          <option value="webhook.">Webhook</option>
          <option value="ota.">OTA 分发</option>
          <option value="node.">节点联邦</option>
          <option value="monitor.">监控令牌</option>
          <option value="settings.">系统设置</option>
        </select>
      </div>
      {loading ? <p className="muted pad">读取审计日志…</p> : paged.length === 0 ? <EmptyState icon={<ScrollText size={24} />} title="暂无审计日志" /> : (
        <>
          <div className="table">
            <div className="tr t-aud th">
              <SortTh label="动作" field="action" sort={sort} onSort={setSort} />
              <SortTh label="操作人" field="actor" sort={sort} onSort={setSort} />
              <span>目标</span><span>详情</span>
              <SortTh label="时间" field="created" sort={sort} onSort={setSort} />
            </div>
            {paged.map(a => (
              <div className="tr t-aud" key={a.id}>
                <span data-label="动作"><Badge tone={actionTone(a.action)}>{a.action}</Badge></span>
                <span className="muted" data-label="操作人">{a.actor}</span>
                <code data-label="目标">{a.target || '—'}</code>
                <span className="muted" data-label="详情">{a.detail || '—'}</span>
                <span className="muted" data-label="时间">{fmtTime(a.created)}</span>
              </div>
            ))}
          </div>
          <Pagination page={curPage} pageSize={pageSize} total={filtered.length} onChange={setPage} />
        </>
      )}
    </Card>
  )
}
