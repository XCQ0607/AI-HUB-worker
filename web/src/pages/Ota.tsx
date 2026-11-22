import { useCallback, useEffect, useState } from 'react'
import { Package, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { api, ago, bytes, shortId, uploadBinary } from '../api'
import { Badge, Card, ConfirmDialog, CopyBtn, EmptyState, Modal, Pagination, platformTone, SortState, SortTh, useToast } from '../components/ui'

const MAX_OTA_BYTES = 32 * 1024 * 1024
const SAFE_SEG = /^[a-zA-Z0-9_-]{1,32}$/

export function Ota() {
  const toast = useToast()
  const [enabled, setEnabled] = useState(false)
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [platFilter, setPlatFilter] = useState('all')
  const [sort, setSort] = useState<SortState>({ field: 'created', dir: 'desc' })
  const [page, setPage] = useState(1)
  const pageSize = 15
  const [open, setOpen] = useState(false)
  const [platform, setPlatform] = useState('win32')
  const [channel, setChannel] = useState('stable')
  const [version, setVersion] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [delItem, setDelItem] = useState<any | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<{ enabled: boolean; items: any[] }>('/ota')
      setEnabled(r.enabled); setItems(r.items)
    } catch (e: any) { toast(e.message, 'error') } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])

  const closePublish = () => {
    setOpen(false)
    setPlatform('win32')
    setChannel('stable')
    setVersion('')
    setFile(null)
  }

  const publish = async () => {
    const plat = platform.trim()
    const chan = channel.trim()
    const ver = version.trim()
    if (!SAFE_SEG.test(plat)) {
      toast('平台名仅允许字母、数字、下划线或连字符（1–32 字符）', 'error'); return
    }
    if (!SAFE_SEG.test(chan)) {
      toast('渠道名仅允许字母、数字、下划线或连字符（1–32 字符）', 'error'); return
    }
    if (!/^\d+\.\d+\.\d+$/.test(ver)) {
      toast('版本号格式需为 X.Y.Z（如 0.5.81）', 'error'); return
    }
    if (!file) {
      toast('请选择 .tar.gz 安装包', 'error'); return
    }
    if (file.size === 0) {
      toast('安装包文件不能为空', 'error'); return
    }
    if (file.size > MAX_OTA_BYTES) {
      toast(`安装包大小 (${bytes(file.size)}) 超过 32 MB 限制`, 'error'); return
    }
    setBusy(true)
    try {
      const params = new URLSearchParams({ platform: plat, channel: chan, version: ver })
      await uploadBinary(`/ota/publish?${params}`, file)
      toast('OTA 包已发布到 R2', 'success')
      closePublish(); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const platforms = Array.from(new Set(['win32', 'darwin', 'linux', ...items.map(r => r.platform).filter(Boolean)]))

  return (
    <div className="stack">
      <Card title="插件 OTA" subtitle="托管插件完整包（.tar.gz）；宿主按平台与渠道拉取最新版本并校验 SHA-256"
        action={
          <div className="btn-row">
            <Badge tone={enabled ? 'ok' : 'warn'}>{enabled ? 'R2 已绑定' : '未绑定 R2'}</Badge>
            <button className="icon-btn" onClick={load} title="刷新" aria-label="刷新 OTA 列表"><RefreshCw size={14} /></button>
            <button className="btn-primary" disabled={!enabled} onClick={() => setOpen(true)}><Upload size={14} />发布包</button>
          </div>
        }>
        {loading ? (
          <p className="muted pad">读取 OTA 版本列表…</p>
        ) : items.length === 0 ? (
          <EmptyState icon={<Package size={24} />} title="暂无 OTA 发布包" hint={enabled ? '点击右上角上传 .tar.gz 紧急安装包' : '需绑定 R2 存储桶 (ENABLE_R2=1) 后才能存储 OTA 包'} />
        ) : (() => {
          const filtered = items
            .filter(r => platFilter === 'all' || r.platform === platFilter)
            .filter(r => !q.trim() || `${r.platform} ${r.channel} ${r.version} ${r.sha256}`.toLowerCase().includes(q.trim().toLowerCase()))
            .sort((a, b) => {
              const m = sort.dir === 'asc' ? 1 : -1
              if (sort.field === 'size' || sort.field === 'created') return (a[sort.field] - b[sort.field]) * m
              return String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? '')) * m
            })
          const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
          const curPage = Math.min(page, totalPages)
          const paged = filtered.slice((curPage - 1) * pageSize, curPage * pageSize)
          return (
            <>
              <div className="toolbar">
                <div className="search-box">
                  <Search size={14} className="muted" />
                  <input placeholder="搜索版本号 / 渠道 / SHA-256…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
                </div>
                <select value={platFilter} onChange={e => { setPlatFilter(e.target.value); setPage(1) }} style={{ width: 130 }}>
                  <option value="all">全部平台</option>
                  {platforms.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {paged.length === 0 ? <EmptyState icon={<Package size={22} />} title="无匹配 OTA 包" /> : (
                <div className="table">
                  <div className="tr t-ota th">
                    <SortTh label="平台 / 渠道" field="platform" sort={sort} onSort={setSort} />
                    <SortTh label="版本" field="version" sort={sort} onSort={setSort} />
                    <SortTh label="大小" field="size" sort={sort} onSort={setSort} />
                    <span>SHA-256</span>
                    <SortTh label="发布时间" field="created" sort={sort} onSort={setSort} />
                    <span />
                  </div>
                  {paged.map(r => {
                    const dl = `${location.origin}/api/desktop-plugins/ota/download/${encodeURIComponent(r.platform)}/${encodeURIComponent(r.channel)}/${encodeURIComponent(r.version)}`
                    return (
                      <div className="tr t-ota" key={r.id}>
                        <span data-label="平台 / 渠道"><span className="btn-row"><Badge tone={platformTone(r.platform)}>{r.platform}</Badge><Badge>{r.channel}</Badge></span></span>
                        <code data-label="版本">v{r.version}</code>
                        <span data-label="大小">{bytes(r.size)}</span>
                        <span data-label="SHA-256"><span className="mono-cell"><code title={r.sha256}>{shortId(r.sha256, 14)}</code><CopyBtn value={r.sha256} label="SHA-256" /></span></span>
                        <span className="muted" data-label="发布时间">{ago(r.created)}</span>
                        <span className="actions">
                          <CopyBtn value={dl} label="下载地址" />
                          <button className="icon-btn danger" title="删除版本" aria-label={`删除 ${r.platform}/${r.channel} v${r.version}`} onClick={() => setDelItem(r)}><Trash2 size={14} /></button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              <Pagination page={curPage} pageSize={pageSize} total={filtered.length} onChange={setPage} />
            </>
          )
        })()}
      </Card>

      <Modal open={open} title="发布插件 OTA 包" onClose={closePublish} footer={
        <>
          <button className="btn-ghost" onClick={closePublish}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={publish}>{busy ? '上传中…' : '确认发布'}</button>
        </>
      }>
        <div className="form">
          <div className="banner">
            <span className="small">平台与渠道仅支持字母、数字、<code>_</code>、<code>-</code>（1–32 字符）；同平台渠道下按 SemVer 版本号自动选取最新版本。</span>
          </div>
          <div className="form-2">
            <label>平台 (platform)<input value={platform} onChange={e => setPlatform(e.target.value)} placeholder="win32 / darwin / linux" /></label>
            <label>渠道 (channel)<input value={channel} onChange={e => setChannel(e.target.value)} placeholder="stable / canary" /></label>
          </div>
          <label>版本号 (X.Y.Z)<input value={version} onChange={e => setVersion(e.target.value)} placeholder="例如 0.5.81" /></label>
          <label>安装包 (.tar.gz，最大 32 MB)
            <input type="file" accept=".gz,.tgz,application/gzip" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <p className={`small ${file.size > MAX_OTA_BYTES ? 'bad' : 'muted'}`}>已选文件：{file.name}（{bytes(file.size)}{file.size > MAX_OTA_BYTES ? ' · 超过 32 MB 上限' : ''}）</p>}
        </div>
      </Modal>

      <ConfirmDialog open={!!delItem} danger busy={busy} title="删除 OTA 版本"
        description={`确定删除 ${delItem?.platform}/${delItem?.channel} v${delItem?.version} 及其 R2 文件吗？`} confirmText="确认删除"
        onCancel={() => setDelItem(null)}
        onConfirm={async () => {
          setBusy(true)
          try { await api(`/ota/${encodeURIComponent(delItem.id)}`, { method: 'DELETE' }); toast('已删除 OTA 版本', 'success'); setDelItem(null); load() }
          catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
        }} />
    </div>
  )
}
