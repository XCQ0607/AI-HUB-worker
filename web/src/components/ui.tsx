import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, Copy, HelpCircle, Info, X,
} from 'lucide-react'

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' | 'info' | 'purple' | 'cyan'
type ToastKind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: ToastKind; text: string }

const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {})

export function useToast() {
  return useContext(ToastCtx)
}

declare const __APP_VERSION__: string
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

export const REPO_URL = 'https://github.com/XCQ0607/AI-HUB-worker'
export const AUTHOR_URL = 'https://github.com/XCQ0607'
export const LICENSE_URL = 'https://github.com/XCQ0607/AI-HUB-worker/blob/main/LICENSE'

export function GitHubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

export function ProjectFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`site-footer ${className}`.trim()}>
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="打开 GitHub 仓库">
        <GitHubIcon size={14} />
        <span>GitHub</span>
      </a>
      <span className="site-footer-sep" aria-hidden="true">·</span>
      <span>Copyright © 2026 <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">XCQ0607</a></span>
      <span className="site-footer-sep" aria-hidden="true">·</span>
      <span>Under <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">MIT License</a></span>
      <span className="site-footer-sep" aria-hidden="true">·</span>
      <span>v{APP_VERSION}</span>
    </footer>
  )
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

export interface SelectOption<T extends string | number = string> {
  value: T
  label: string
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  style,
  className = '',
  placeholder = '请选择',
  disabled = false,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  style?: CSSProperties
  className?: string
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)

  const selected = options.find(o => o.value === value)

  useEffect(() => {
    if (!open) return
    const idx = options.findIndex(o => o.value === value)
    setActiveIndex(idx >= 0 ? idx : 0)

    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(i => (options.length ? (i + 1) % options.length : -1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(i => (options.length ? (i - 1 + options.length) % options.length : -1))
      } else if (e.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) {
        e.preventDefault()
        onChange(options[activeIndex].value)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, options, value, activeIndex, onChange])

  return (
    <div ref={wrapRef} className={`select-wrap ${open ? 'open' : ''} ${className}`.trim()} style={style}>
      <button
        type="button"
        className="select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen(o => !o)}
      >
        <span className={`select-label ${selected ? '' : 'muted'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={14} className="select-caret" />
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          {options.map((opt, idx) => {
            const isSelected = opt.value === value
            const isActive = idx === activeIndex
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`select-option ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`.trim()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
              >
                <span className="select-option-label">{opt.label}</span>
                {isSelected && <Check size={14} className="select-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
