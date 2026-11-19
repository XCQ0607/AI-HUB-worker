import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Download, KeyRound, Laptop, Plus, RefreshCw, Search, ShieldAlert, Trash2, Unlink } from 'lucide-react'
import { api, ago, fmtTime, shortId } from '../api'
import { Badge, BatchBar, Card, ConfirmDialog, CopyBtn, Drawer, EmptyState, Modal, Pagination, SortTh, type SortState, useToast } from '../components/ui'

function expiryBadge(exp?: number | null) {
  if (!exp) return <Badge tone="cyan">永久有效</Badge>
  const left = exp - Date.now()
  if (left <= 0) return <Badge tone="bad">已过期</Badge>
  const days = Math.ceil(left / 86400_000)
  return <Badge tone={days <= 3 ? 'warn' : 'info'}>剩 {days} 天</Badge>
}

export function Licenses() {
  const toast = useToast()
  const [items, setItems] = useState<any[]>([])
  const [mode, setMode] = useState<'open' | 'restricted'>('open')
  const [controlled, setControlled] = useState(false)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked' | 'expired'>('all')
  const [sort, setSort] = useState<SortState>({ field: 'created', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [note, setNote] = useState('')
  const [count, setCount] = useState(1)
  const [deviceLimit, setDeviceLimit] = useState(1)
  const [expiresInDays, setExpiresInDays] = useState(0)
  const [customCode, setCustomCode] = useState('')
  const [made, setMade] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  // Renew modal & Devices drawer
  const [renewTarget, setRenewTarget] = useState<any | null>(null)
  const [renewDays, setRenewDays] = useState(30)
  const [selected, setSelected] = useState<any | null>(null)
  const [devices, setDevices] = useState<any[]>([])
  const [loadingDev, setLoadingDev] = useState(false)

  // Confirms
  const [delLic, setDelLic] = useState<any | null>(null)
  const [unbindAll, setUnbindAll] = useState<any | null>(null)
  const [batchDel, setBatchDel] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([api<{ items: any[] }>('/licenses'), api<any>('/settings')])
      setItems(l.items)
      setMode(s.mode)
      setControlled(!!s.modeControlled)
    } catch (e: any) { toast(e.message, 'error') }
  }, [toast])

  useEffect(() => { load() }, [load])

  const openDevices = async (lic: any) => {
    setSelected(lic)
    setLoadingDev(true)
    try { setDevices((await api<{ items: any[] }>(`/licenses/${lic.id}/devices`)).items) }
    catch (e: any) { toast(e.message, 'error') } finally { setLoadingDev(false) }
  }

  const switchMode = async (next: 'open' | 'restricted') => {
    try {
      await api('/settings', { method: 'PUT', body: { mode: next } })
      setMode(next)
      toast(next === 'restricted' ? '已切换为限制模式（需激活码）' : '已切换为开放模式', 'success')
    } catch (e: any) { toast(e.message, 'error') }
  }

  const create = async () => {
    setCreating(true)
    try {
      const r = await api<{ codes: string[] }>('/licenses', {
        body: { note, count, deviceLimit, expiresInDays, code: count === 1 && customCode.trim() ? customCode.trim() : undefined },
      })
      setMade(r.codes)
      toast(`已生成 ${r.codes.length} 个激活码`, 'success')
      load()
    } catch (e: any) { toast(e.message, 'error') } finally { setCreating(false) }
  }

  const runBatch = async (action: 'activate' | 'revoke' | 'unbind' | 'delete' | 'renew', days?: number) => {
    setBusy(true)
    try {
      await api('/licenses/batch', { body: { ids: [...selectedIds], action, days } })
      toast('批量操作完成', 'success')
      setSelectedIds(new Set()); setBatchDel(false); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const filtered = items
    .filter(l => {
      const exp = l.expiresAt && l.expiresAt < Date.now()
      if (statusFilter === 'active' && (l.status !== 'active' || exp)) return false
      if (statusFilter === 'revoked' && l.status !== 'revoked') return false
      if (statusFilter === 'expired' && !exp) return false
      if (q.trim() && !`${l.code} ${l.note} ${l.bound ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      const m = sort.dir === 'asc' ? 1 : -1
      const va = sort.field === 'expiresAt' ? (a.expiresAt ?? Number.MAX_SAFE_INTEGER) : (a[sort.field] ?? 0)
      const vb = sort.field === 'expiresAt' ? (b.expiresAt ?? Number.MAX_SAFE_INTEGER) : (b[sort.field] ?? 0)
      return typeof va === 'number' && typeof vb === 'number' ? (va - vb) * m : String(va).localeCompare(String(vb)) * m
    })

  const pageSize = 10
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  return (
    <div className="stack">
      <Card title="准入模式" subtitle="控制哪些宿主电脑可以向本中转建立 /tunnel 隧道"
        action={
          <div className="seg">
            {(['open', 'restricted'] as const).map(m => (
              <button key={m} disabled={controlled} className={mode === m ? 'active' : ''} onClick={() => switchMode(m)}>
                {m === 'open' ? '开放模式' : '限制模式'}
              </button>
            ))}
          </div>
        }>
        <div className="banner">
          {mode === 'restricted'
            ? <><ShieldAlert size={16} className="warn" /><span>当前为 <b>限制模式</b>：宿主插件必须携带有效且未过期的激活码（请求头 <code>x-dsh-license</code>）方可通过握手。</span></>
            : <span>当前为 <b>开放模式</b>：任何知道本中转地址的宿主都可直接建隧道（仍受 <code>TUNNEL_REGISTER_SECRET</code> 约束）。</span>}
        </div>
      </Card>

      <Card title="激活码台账" subtitle="支持有效期控制、多机配额、批量操作与 CSV/TXT 导出"
        action={
          <div className="btn-row">
            <a className="btn-ghost btn-sm" href="/api/platform/v1/licenses/export?format=csv" download><Download size={13} />CSV</a>
            <a className="btn-ghost btn-sm" href="/api/platform/v1/licenses/export?format=txt" download><Download size={13} />TXT</a>
            <button className="icon-btn" onClick={load} title="刷新"><RefreshCw size={14} /></button>
            <button className="btn-primary" onClick={() => { setMade([]); setNote(''); setCustomCode(''); setCount(1); setDeviceLimit(1); setExpiresInDays(0); setCreateOpen(true) }}>
              <Plus size={14} />生成激活码
            </button>
          </div>
        }>
        <div className="toolbar">
          <div className="search-box">
            <Search size={14} className="muted" />
            <input placeholder="按激活码 / 备注 / 设备搜索…" value={q} onChange={e => { setQ(e.target.value); setPage(1); setSelectedIds(new Set()) }} />
          </div>
          <div className="seg">
            {([['all', '全部'], ['active', '有效'], ['expired', '已过期'], ['revoked', '已吊销']] as const).map(([k, lbl]) => (
              <button key={k} className={statusFilter === k ? 'active' : ''} onClick={() => { setStatusFilter(k); setPage(1); setSelectedIds(new Set()) }}>{lbl}</button>
            ))}
          </div>
        </div>

        <BatchBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('activate')}>恢复有效</button>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('revoke')}>批量吊销</button>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('renew', 30)}>续期 30 天</button>
          <button className="btn-ghost btn-sm" onClick={() => runBatch('unbind')}>解绑设备</button>
          <button className="btn-ghost btn-sm danger" onClick={() => setBatchDel(true)}>批量删除</button>
        </BatchBar>

        {paged.length === 0 ? (
          <EmptyState icon={<KeyRound size={24} />} title={items.length === 0 ? '暂无激活码' : '没有匹配的激活码'} hint="点击右上角「生成激活码」创建授权凭据" />
        ) : (
          <div className="table">
            <div className="tr t-lic th">
              <input type="checkbox" checked={paged.length > 0 && paged.every(l => selectedIds.has(l.id))}
                onChange={e => {
                  const n = new Set(selectedIds)
                  paged.forEach(l => e.target.checked ? n.add(l.id) : n.delete(l.id))
                  setSelectedIds(n)
                }} />
              <SortTh label="激活码" field="code" sort={sort} onSort={setSort} />
              <SortTh label="状态" field="status" sort={sort} onSort={setSort} />
              <SortTh label="设备" field="deviceCount" sort={sort} onSort={setSort} />
              <SortTh label="有效期" field="expiresAt" sort={sort} onSort={setSort} />
              <span>备注</span>
              <SortTh label="创建" field="created" sort={sort} onSort={setSort} />
              <span />
            </div>
            {paged.map(l => (
              <div className="tr t-lic" key={l.id}>
                <label className="chk-row" data-label="选择">
                  <input type="checkbox" checked={selectedIds.has(l.id)} onChange={e => {
                    const n = new Set(selectedIds); e.target.checked ? n.add(l.id) : n.delete(l.id); setSelectedIds(n)
                  }} />
                </label>
                <span className="mono-cell" data-label="激活码"><code>{l.code}</code><CopyBtn value={l.code} label="激活码" /></span>
                <span data-label="状态">{l.status === 'revoked' ? <Badge tone="bad">已吊销</Badge> : l.expiresAt && l.expiresAt < Date.now() ? <Badge tone="warn">已过期</Badge> : <Badge tone="ok" dot>有效</Badge>}</span>
                <span data-label="绑定设备">
                  <button className="btn-link" onClick={() => openDevices(l)}>
                    <Laptop size={13} />{l.deviceCount ?? 0} / {l.deviceLimit ?? 1}
                  </button>
                </span>
                <span data-label="有效期">{expiryBadge(l.expiresAt)}</span>
                <span className="muted ellipsis" data-label="备注" title={l.note}>{l.note || '—'}</span>
                <span className="muted" data-label="创建">{ago(l.created)}</span>
                <span className="actions">
                  <button className="icon-btn" title="续期/改有效期" onClick={() => { setRenewTarget(l); setRenewDays(30) }}><CalendarClock size={14} /></button>
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    try { await api(`/licenses/${l.id}/toggle`, { method: 'POST' }); toast('状态已更新', 'success'); load() }
                    catch (e: any) { toast(e.message, 'error') }
                  }}>{l.status === 'active' ? '吊销' : '恢复'}</button>
                  {(l.deviceCount > 0 || l.bound) && <button className="icon-btn" title="解绑全部" onClick={() => setUnbindAll(l)}><Unlink size={14} /></button>}
                  <button className="icon-btn danger" title="删除" onClick={() => setDelLic(l)}><Trash2 size={14} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
        <Pagination total={filtered.length} page={safePage} pageSize={pageSize} onChange={setPage} />
      </Card>

      <Modal open={createOpen} title="生成激活码" onClose={() => setCreateOpen(false)} width={480}
        footer={made.length ? <button className="btn-primary" onClick={() => setCreateOpen(false)}>完成</button> : (
          <>
            <button className="btn-ghost" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn-primary" disabled={creating} onClick={create}>{creating ? '生成中…' : '立即生成'}</button>
          </>
        )}>
        {made.length > 0 ? (
          <div className="stack-sm">
            <p className="muted">成功生成 {made.length} 个激活码：</p>
            <div className="code-box"><pre>{made.join('\n')}</pre><CopyBtn value={made.join('\n')} label="全部激活码" /></div>
          </div>
        ) : (
          <div className="form">
            <div className="form-2">
              <label>生成数量 (1–100)<input type="number" min={1} max={100} value={count} onChange={e => setCount(Math.max(1, +e.target.value))} /></label>
              <label>单码可绑设备 (1–50)<input type="number" min={1} max={50} value={deviceLimit} onChange={e => setDeviceLimit(Math.max(1, +e.target.value))} /></label>
            </div>
            <label>有效期
              <select value={expiresInDays} onChange={e => setExpiresInDays(+e.target.value)}>
                <option value={0}>永久有效</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
                <option value={90}>90 天</option>
                <option value={365}>365 天</option>
              </select>
            </label>
            {count === 1 && <label>自定义激活码（可选）<input placeholder="如 AIHUB-VIP-0001" value={customCode} onChange={e => setCustomCode(e.target.value)} /></label>}
            <label>备注（可选）<input placeholder="例如：家里的 Mac mini" value={note} onChange={e => setNote(e.target.value)} /></label>
          </div>
        )}
      </Modal>

      <Modal open={!!renewTarget} title="续期 / 修改有效期" onClose={() => setRenewTarget(null)} width={420} footer={
        <>
          <button className="btn-ghost" onClick={() => setRenewTarget(null)}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={async () => {
            setBusy(true)
            try { await api(`/licenses/${renewTarget.id}/renew`, { body: { days: renewDays } }); toast('有效期已更新', 'success'); setRenewTarget(null); load() }
            catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
          }}>确认</button>
        </>
      }>
        <div className="form">
          <p className="muted small">激活码：<code>{renewTarget?.code}</code></p>
          <label>选择续期方案
            <select value={renewDays} onChange={e => setRenewDays(+e.target.value)}>
              <option value={7}>延长 7 天</option>
              <option value={30}>延长 30 天</option>
              <option value={90}>延长 90 天</option>
              <option value={365}>延长 365 天</option>
              <option value={0}>设为永久有效</option>
            </select>
          </label>
        </div>
      </Modal>

      <Drawer open={!!selected} title="已绑定设备" subtitle={selected?.code} onClose={() => setSelected(null)}>
        {loadingDev ? <p className="muted">加载设备列表…</p> : devices.length === 0 ? (
          <EmptyState icon={<Laptop size={22} />} title="尚未绑定设备" hint="宿主首次携带该激活码连入 /tunnel 时会自动绑定" />
        ) : (
          <div className="stack-sm">
            {devices.map(d => (
              <div className="dev-card" key={d.id}>
                <div>
                  <div className="dev-name">{d.deviceName || shortId(d.deviceId, 26)}</div>
                  <div className="muted small">ID: <code>{shortId(d.deviceId, 28)}</code></div>
                  <div className="muted small">{d.platform || 'host'} · 绑定 {fmtTime(d.boundAt)} · 最近 {ago(d.lastSeenAt)}</div>
                </div>
                <button className="btn-ghost btn-sm danger" onClick={async () => {
                  try { await api(`/licenses/${selected.id}/devices/${encodeURIComponent(d.deviceId)}`, { method: 'DELETE' }); toast('已解绑设备', 'success'); openDevices(selected); load() }
                  catch (e: any) { toast(e.message, 'error') }
                }}>解绑</button>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <ConfirmDialog open={!!unbindAll} busy={busy} title="解绑全部设备"
        description={`确定清空激活码 ${unbindAll?.code} 下的全部绑定设备吗？`} confirmText="确认解绑"
        onCancel={() => setUnbindAll(null)}
        onConfirm={async () => {
          setBusy(true)
          try { await api(`/licenses/${unbindAll.id}/unbind`, { method: 'POST' }); toast('已清空设备绑定', 'success'); setUnbindAll(null); load() }
          catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />

      <ConfirmDialog open={!!delLic} danger busy={busy} title="删除激活码"
        description={`确定删除激活码 ${delLic?.code} 及其关联设备记录吗？`} confirmText="确认删除"
        onCancel={() => setDelLic(null)}
        onConfirm={async () => {
          setBusy(true)
          try {
            await api(`/licenses/${delLic.id}`, { method: 'DELETE' })
            toast('已删除激活码', 'success')
            setSelectedIds(prev => { const n = new Set(prev); n.delete(delLic.id); return n })
            setDelLic(null); load()
          } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />

      <ConfirmDialog open={batchDel} danger busy={busy} title="批量删除激活码"
        description={`确定删除选中的 ${selectedIds.size} 个激活码及设备记录吗？`} confirmText="确认删除"
        onCancel={() => setBatchDel(false)} onConfirm={() => runBatch('delete')} />
    </div>
  )
}
