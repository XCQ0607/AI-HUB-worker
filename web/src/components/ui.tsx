import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2,
  ChevronLeft, ChevronRight, Copy, HelpCircle, Info, X,
} from 'lucide-react'

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' | 'info' | 'purple' | 'cyan'
type ToastKind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: ToastKind; text: string }

const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {})

export function useToast() {
  return useContext(ToastCtx)
}

export function BrandLogo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className="brand-svg" aria-hidden="true">
      <defs>
        <linearGradient id="aihub-lg" x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6C8CFF" />
          <stop offset="0.55" stopColor="#8A6EFF" />
          <stop offset="1" stopColor="#34D399" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#aihub-lg)" />
      <path d="M32 14L17 46h7.2l3.1-7h9.4l3.1 7H47L32 14zm0 11.8l3.2 7.4h-6.4l3.2-7.4z" fill="#fff" />
      <circle cx="32" cy="14" r="3" fill="#34D399" />
      <circle cx="17" cy="46" r="2.6" fill="#fff" />
      <circle cx="47" cy="46" r="2.6" fill="#fff" />
      <path d="M13 27c3.5-5.5 9.5-9 19-9s15.5 3.5 19 9" stroke="#fff" strokeOpacity="0.38" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 4" />
    </svg>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random()
    setItems(prev => [...prev.slice(-4), { id, kind, text }])
    setTimeout(() => setItems(prev => prev.filter(x => x.id !== id)), 3200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
            <span>{t.text}</span>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setItems(p => p.filter(x => x.id !== t.id))}><X size={13} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function Modal({ open, title, onClose, children, footer, width = 480 }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" style={{ maxWidth: width }}>
        <div className="dialog-hd">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="dialog-bd">{children}</div>
        {footer && <div className="dialog-ft">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, description, confirmText = '确认', danger = false, busy = false, onConfirm, onCancel }: {
  open: boolean; title: string; description: string; confirmText?: string; danger?: boolean; busy?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel} width={420} footer={
      <>
        <button className="btn-ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : confirmText}
        </button>
      </>
    }>
      <div className="confirm-body">
        {danger && <div className="confirm-icon"><AlertTriangle size={20} /></div>}
        <p className="muted">{description}</p>
      </div>
    </Modal>
  )
}

export function Drawer({ open, title, subtitle, onClose, children }: {
  open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="overlay drawer-wrap" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="drawer">
        <div className="dialog-hd">
          <div>
            <h3>{title}</h3>
            {subtitle && <small className="muted">{subtitle}</small>}
          </div>
          <button className="icon-btn" aria-label="关闭抽屉" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="drawer-bd">{children}</div>
      </aside>
    </div>
  )
}

export function Badge({ tone = 'neutral', dot = false, icon, children }: {
  tone?: BadgeTone; dot?: boolean; icon?: ReactNode; children: ReactNode
}) {
  return <span className={`badge badge-${tone}`}>{dot && <i className="b-dot" />}{icon}{children}</span>
}

export function actionTone(action: string): BadgeTone {
  if (action.startsWith('auth.') || action.startsWith('admin.')) return 'purple'
  if (action.includes('delete') || action.includes('kick') || action.includes('revoke') || action.includes('clear') || action.includes('forget')) return 'bad'
  if (action.includes('create') || action.includes('publish') || action.includes('enable')) return 'ok'
  if (action.startsWith('settings.') || action.includes('mode') || action.includes('toggle')) return 'warn'
  if (action.startsWith('webhook.') || action.startsWith('push.')) return 'cyan'
  if (action.startsWith('node.') || action.startsWith('migration.')) return 'info'
  return 'accent'
}

export function platformTone(platform: string): BadgeTone {
  const p = (platform || '').toLowerCase()
  if (p.includes('ios') || p.includes('darwin') || p.includes('mac')) return 'purple'
  if (p.includes('win')) return 'info'
  if (p.includes('linux')) return 'warn'
  if (p.includes('android')) return 'ok'
  return 'cyan'
}

export function Card({ title, subtitle, tip, action, children, className = '' }: {
  title?: string; subtitle?: string; tip?: string; action?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-hd">
          <div>
            {title && (
              <div className="card-title-row">
                <h3>{title}</h3>
                {tip && <span className="tip-icon" title={tip}><HelpCircle size={13} /></span>}
              </div>
            )}
            {subtitle && <p className="muted sub">{subtitle}</p>}
          </div>
          {action && <div className="card-act">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatCard({ label, value, hint, icon, tone, onClick }: {
  label: string; value: ReactNode; hint?: string; icon?: ReactNode; tone?: 'ok' | 'warn' | 'accent' | 'purple' | 'cyan'; onClick?: () => void
}) {
  return (
    <div
      className={`stat ${tone ? 'stat-' + tone : ''} ${onClick ? 'clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
    >
      <div className="stat-top"><span>{label}</span>{icon}</div>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-ic">{icon}</div>}
      <p>{title}</p>
      {hint && <small className="muted">{hint}</small>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}

export function CopyBtn({ value, label, text }: { value: string; label?: string; text?: string }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const run = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast(label ? `已复制${label}` : '已复制到剪贴板', 'success')
      setTimeout(() => setCopied(false), 1400)
    } catch {
      toast('复制失败，请手动复制', 'error')
    }
  }
  return (
    <button type="button" className={text ? 'btn-ghost btn-sm' : 'icon-btn'} title="复制" aria-label={label ? `复制${label}` : '复制'} onClick={run}>
      {copied ? <Check size={14} className="ok" /> : <Copy size={14} />}
      {text && <span>{copied ? '已复制' : text}</span>}
    </button>
  )
}

export function ProgressBar({ value, max, tone = 'accent' }: { value: number; max: number; tone?: 'accent' | 'ok' | 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="bar-wrap" title={`${pct}%`}>
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export interface SortState { field: string; dir: 'asc' | 'desc' }

export function SortTh({ label, field, sort, onSort }: {
  label: string; field: string; sort: SortState; onSort: (s: SortState) => void
}) {
  const active = sort.field === field
  return (
    <button
      type="button"
      className={`sort-th ${active ? 'active' : ''}`}
      onClick={() => onSort({ field, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
    >
      <span>{label}</span>
      {active ? (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="sort-idle" />}
    </button>
  )
}

export function BatchBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count <= 0) return null
  return (
    <div className="batch-bar">
      <div className="batch-info">
        <Badge tone="accent">已选 {count} 项</Badge>
        <button type="button" className="btn-link small" onClick={onClear}>取消选择</button>
      </div>
      <div className="btn-row">{children}</div>
    </div>
  )
}

export function Pagination({ total, page, pageSize, onChange }: {
  total: number; page: number; pageSize: number; onChange: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return (
    <div className="pager">
      <span className="muted small">共 {total} 条 · 第 {page} / {pages} 页</span>
      <div className="btn-row">
        <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft size={14} />上一页
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          下一页<ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}
