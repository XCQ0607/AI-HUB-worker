import { useCallback, useEffect, useState } from 'react'
import { Plug, Power, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, ago, fmtTime, shortId } from '../api'
import { Badge, BatchBar, Card, ConfirmDialog, CopyBtn, Drawer, EmptyState, Pagination, SortTh, type SortState, useToast } from '../components/ui'

export function Tunnels() {
  const toast = useToast()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [sort, setSort] = useState<SortState>({ field: 'lastSeen', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [detail, setDetail] = useState<any | null>(null)
  const [confirmAct, setConfirmAct] = useState<{ kind: 'kick' | 'delete' | 'batchDel'; item?: any } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const t = await api<{ items: any[] }>('/tunnels')
      setItems(t.items)
      setDetail((prev: any) => prev ? (t.items.find((x: any) => x.id === prev.id) ?? prev) : null)
    } catch (e: any) { toast(e.message, 'error') } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const filtered = items
    .filter(t => {
      if (filter === 'online' && !t.online) return false
      if (filter === 'offline' && t.online) return false
      if (q.trim() && !`${t.id} ${t.ip} ${t.version}`.toLowerCase().includes(q.trim().toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      const m = sort.dir === 'asc' ? 1 : -1
      const va = sort.field === 'online' ? (a.online ? 1 : 0) : (a[sort.field] ?? 0)
      const vb = sort.field === 'online' ? (b.online ? 1 : 0) : (b[sort.field] ?? 0)
      return typeof va === 'number' && typeof vb === 'number' ? (va - vb) * m : String(va).localeCompare(String(vb)) * m
    })

  const pageSize = 10
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const executeConfirm = async () => {
    if (!confirmAct) return
    setBusy(true)
    try {
      if (confirmAct.kind === 'kick') {
        await api(`/tunnels/${encodeURIComponent(confirmAct.item.id)}/kick`, { method: 'POST' })
        toast('已断开该宿主隧道', 'success')
      } else if (confirmAct.kind === 'delete') {
        await api(`/tunnels/${encodeURIComponent(confirmAct.item.id)}`, { method: 'DELETE' })
        toast('已移除离线实例记录', 'success')
        setSelectedIds(prev => { const n = new Set(prev); n.delete(confirmAct.item.id); return n })
      } else if (confirmAct.kind === 'batchDel') {
        const ids = [...selectedIds]
        const succeeded = new Set<string>()
        const failed: string[] = []
        for (const id of ids) {
          const t = items.find(x => x.id === id)
          try {
            if (t?.online) await api(`/tunnels/${encodeURIComponent(id)}/kick`, { method: 'POST' })
            else await api(`/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' })
            succeeded.add(id)
          } catch (err: any) {
            failed.push(`${shortId(id, 12)}: ${err?.message || '失败'}`)
          }
        }
        setSelectedIds(prev => {
          const next = new Set(prev)
          succeeded.forEach(id => next.delete(id))
          return next
        })
        if (failed.length === 0) toast(`批量操作完成（共 ${succeeded.size} 项）`, 'success')
        else toast(`成功 ${succeeded.size} 项，失败 ${failed.length} 项（${failed[0]}）`, 'error')
      }
      setConfirmAct(null)
      if (detail?.id === confirmAct.item?.id) setDetail(null)
      load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <div className="stack">
      <Card title="宿主实例" subtitle="每台电脑以唯一 instanceId 注册出站 WSS 隧道，同实例重连自动顶替旧连接"
        action={<button className="icon-btn" onClick={load} title="刷新" aria-label="刷新隧道列表"><RefreshCw size={14} /></button>}>
          <div className="toolbar">
            <div className="search-box">
              <Search size={14} className="muted" />
              <input placeholder="按实例 ID / IP / 版本搜索…" value={q} onChange={e => { setQ(e.target.value); setPage(1); setSelectedIds(new Set()) }} />
            </div>
            <div className="seg">
              {([['all', `全部 (${items.length})`], ['online', `在线 (${items.filter(x => x.online).length})`], ['offline', '离线']] as const).map(([k, lbl]) => (
                <button key={k} className={filter === k ? 'active' : ''} onClick={() => { setFilter(k); setPage(1); setSelectedIds(new Set()) }}>{lbl}</button>
              ))}
            </div>
          </div>

          <BatchBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
            <button className="btn-ghost btn-sm danger" onClick={() => setConfirmAct({ kind: 'batchDel' })}>批量断开 / 清理</button>
          </BatchBar>

          {loading ? <p className="muted pad">读取隧道列表…</p> : paged.length === 0 ? (
            <EmptyState icon={<Plug size={24} />} title="没有匹配的宿主实例" hint="在桌面插件中填入本中转地址后会自动出现" />
          ) : (
            <div className="table">
              <div className="tr t-tun th">
                <input type="checkbox" aria-label="全选当前页宿主实例" checked={paged.length > 0 && paged.every(t => selectedIds.has(t.id))}
                  onChange={e => {
                    const n = new Set(selectedIds)
                    paged.forEach(t => e.target.checked ? n.add(t.id) : n.delete(t.id))
                    setSelectedIds(n)
                  }} />
                <SortTh label="实例 ID" field="id" sort={sort} onSort={setSort} />
                <SortTh label="状态" field="online" sort={sort} onSort={setSort} />
                <SortTh label="版本" field="version" sort={sort} onSort={setSort} />
                <span>来源 IP</span>
                <SortTh label="最近活跃" field="lastSeen" sort={sort} onSort={setSort} />
                <span />
              </div>
              {paged.map(t => (
                <div
                  className="tr t-tun clickable"
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetail(t)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(t) } }}
                >
                  <label className="chk-row" data-label="选择" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`选择实例 ${t.id}`} checked={selectedIds.has(t.id)} onChange={e => {
                      const n = new Set(selectedIds); e.target.checked ? n.add(t.id) : n.delete(t.id); setSelectedIds(n)
                    }} />
                  </label>
                  <span className="mono-cell" data-label="实例 ID">
                    <code title={t.id}>{shortId(t.id, 24)}</code>
                    <span onClick={e => e.stopPropagation()}><CopyBtn value={t.id} label="实例 ID" /></span>
                  </span>
                  <span data-label="状态">
                    {t.online ? <Badge tone="ok" dot>在线 · {t.pending} 在途</Badge>
                      : <Badge tone="neutral">离线</Badge>}
                  </span>
                  <span data-label="插件版本">{t.version ? <Badge tone="accent">{t.version}</Badge> : '—'}</span>
                  <span className="muted ellipsis" data-label="来源 IP" title={t.ip || ''}>{t.ip || '—'}</span>
                  <span className="muted" data-label="最近活跃">{t.online ? `${ago(t.connectedAt)}连入` : ago(t.lastSeen)}</span>
                  <span className="actions" onClick={e => e.stopPropagation()}>
                    {t.online
                      ? <button className="icon-btn danger" title="断开隧道" aria-label={`断开实例 ${t.id}`} onClick={() => setConfirmAct({ kind: 'kick', item: t })}><Power size={14} /></button>
                      : <button className="icon-btn danger" title="删除记录" aria-label={`删除实例 ${t.id}`} onClick={() => setConfirmAct({ kind: 'delete', item: t })}><Trash2 size={14} /></button>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <Pagination total={filtered.length} page={safePage} pageSize={pageSize} onChange={setPage} />
      </Card>

      <Drawer open={!!detail} title="实例详情" subtitle={detail?.id} onClose={() => setDetail(null)}>
        {detail && (
          <div className="stack">
            <div className="kv-list">
              <div className="kv-row"><span className="muted">实例 ID</span><div className="kv-val"><code>{detail.id}</code><CopyBtn value={detail.id} /></div></div>
              <div className="kv-row"><span className="muted">连接状态</span>{detail.online ? <Badge tone="ok" dot>在线</Badge> : <Badge>离线</Badge>}</div>
              <div className="kv-row"><span className="muted">在途请求</span><span>{detail.pending ?? 0}</span></div>
              <div className="kv-row"><span className="muted">插件版本</span><span>{detail.version || '未知'}</span></div>
              <div className="kv-row"><span className="muted">来源 IP</span><span>{detail.ip || '—'}</span></div>
              <div className="kv-row"><span className="muted">使用激活码</span><code>{detail.license || '无（开放模式）'}</code></div>
              <div className="kv-row"><span className="muted">首次连入</span><span>{fmtTime(detail.firstSeen)}</span></div>
              <div className="kv-row"><span className="muted">最近活跃</span><span>{fmtTime(detail.lastSeen)}</span></div>
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog open={!!confirmAct} danger busy={busy}
        title={confirmAct?.kind === 'kick' ? '断开宿主隧道' : confirmAct?.kind === 'batchDel' ? '批量断开 / 清理' : '删除实例记录'}
        description={confirmAct?.kind === 'kick' ? `确定强制断开实例 ${shortId(confirmAct.item.id, 18)} 的隧道吗？`
          : confirmAct?.kind === 'batchDel' ? `确定处理选中的 ${selectedIds.size} 个实例（在线踢出、离线删除）吗？`
          : `确定移除离线实例 ${shortId(confirmAct?.item?.id ?? '', 18)} 的历史记录吗？`}
        confirmText="确认执行" onCancel={() => setConfirmAct(null)} onConfirm={executeConfirm} />
    </div>
  )
}
