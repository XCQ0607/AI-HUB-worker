import { useCallback, useEffect, useState } from 'react'
import {
  Database, KeyRound, LayoutDashboard, LogOut, Menu, Moon, Network, Package, Plug, ScrollText, Settings, Sun, X,
} from 'lucide-react'
import { api } from './api'
import { APP_VERSION, BrandLogo, GitHubIcon, ProjectFooter, REPO_URL, ToastProvider, useToast } from './components/ui'
import { Audit } from './pages/Audit'
import { Licenses } from './pages/Licenses'
import { Nodes } from './pages/Nodes'
import { Ota } from './pages/Ota'
import { Overview } from './pages/Overview'
import { SettingsPage } from './pages/Settings'
import { Storage } from './pages/Storage'
import { Tunnels } from './pages/Tunnels'

export type Tab = 'overview' | 'tunnels' | 'storage' | 'licenses' | 'nodes' | 'ota' | 'audit' | 'settings'

const NAV: { group: string; items: [Tab, string, typeof Plug][] }[] = [
  {
    group: '运行监控',
    items: [
      ['overview', '概览', LayoutDashboard],
      ['tunnels', '在线隧道', Plug],
      ['storage', '存储与推送', Database],
      ['audit', '审计日志', ScrollText],
    ],
  },
  {
    group: '控制与分发',
    items: [
      ['licenses', '准入与激活码', KeyRound],
      ['nodes', '节点联邦', Network],
      ['ota', '插件 OTA', Package],
      ['settings', '系统设置', Settings],
    ],
  },
]

const ALL_TABS = NAV.flatMap(g => g.items)

function Login({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true); setErr('')
    try {
      const res = await api<{ ok: boolean; totpRequired?: boolean }>('/auth/login', {
        body: { email, password, ...(needTotp ? { totpCode } : {}) },
      })
      if (res.totpRequired) {
        setNeedTotp(true)
        toast('请输入两步动态验证码或恢复码', 'info')
        return
      }
      toast('欢迎回来', 'success')
      onDone()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand">
          <BrandLogo size={36} />
          <div>
            <h1>AI-HUB Relay</h1>
            <p className="muted">Cloudflare Worker 中转控制台</p>
          </div>
        </div>
        <div className="form">
          {!needTotp ? (
            <>
              <label>管理员邮箱<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder="admin@example.com" /></label>
              <label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && go()} /></label>
            </>
          ) : (
            <>
              <div className="banner"><span>正在验证 <b>{email}</b> 的两步验证</span></div>
              <label>6 位动态验证码或 8 位恢复码
                <input value={totpCode} onChange={e => setTotpCode(e.target.value)} autoComplete="one-time-code" placeholder="123456 或 ABCD-EF12" onKeyDown={e => e.key === 'Enter' && go()} autoFocus />
              </label>
            </>
          )}
          {err && <p className="bad small">{err}</p>}
          <div className="btn-row">
            {needTotp && <button className="btn-ghost" onClick={() => { setNeedTotp(false); setTotpCode(''); setErr('') }}>返回</button>}
            <button className="btn-primary btn-lg" style={{ flex: 1 }} disabled={busy} onClick={go}>{busy ? '验证中…' : needTotp ? '验证并登录' : '登录控制台'}</button>
          </div>
        </div>
      </div>
      <ProjectFooter className="login-footer" />
    </div>
  )
}

function Shell() {
  const [me, setMe] = useState<string | null | undefined>(undefined)
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab
    return ALL_TABS.some(t => t[0] === h) ? h : 'overview'
  })
  const [dark, setDark] = useState(() => localStorage.theme !== 'light')
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.theme = dark ? 'dark' : 'light'
  }, [dark])

  const check = useCallback(() => api<{ email: string }>('/auth/me').then(r => setMe(r.email)).catch(() => setMe(null)), [])
  useEffect(() => { check() }, [check])

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1) as Tab
      setTab(ALL_TABS.some(t => t[0] === h) ? h : 'overview')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (t: Tab) => { setTab(t); location.hash = t; setMenuOpen(false) }

  if (me === undefined) return null
  if (!me) return <Login onDone={check} />

  const currentTitle = ALL_TABS.find(t => t[0] === tab)?.[1] ?? '概览'
  const renderPage = () => {
    switch (tab) {
      case 'overview': return <Overview onNav={go} />
      case 'tunnels': return <Tunnels />
      case 'storage': return <Storage />
      case 'licenses': return <Licenses />
      case 'nodes': return <Nodes />
      case 'ota': return <Ota />
      case 'audit': return <Audit />
      case 'settings': return <SettingsPage onLogout={() => setMe(null)} />
    }
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand-row">
          <div className="brand"><BrandLogo size={32} /><div><h2>AI-HUB</h2><small className="muted">Worker Relay · v{APP_VERSION}</small></div></div>
          <button className="icon-btn mobile-only" aria-label="关闭侧边栏" onClick={() => setMenuOpen(false)}><X size={18} /></button>
        </div>
        <nav className="nav">
          {NAV.map(g => (
            <div className="nav-group" key={g.group}>
              <div className="nav-lbl">{g.group}</div>
              {g.items.map(([k, label, Icon]) => (
                <button key={k} className={`nav-item ${tab === k ? 'active' : ''}`} onClick={() => go(k)}>
                  <Icon size={16} /><span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="foot">
          <div className="user-pill" title={me}>{me}</div>
          <div className="foot-act">
            <div className="btn-row">
              <button className="icon-btn" title="切换主题" aria-label={dark ? '切换为浅色主题' : '切换为深色主题'} onClick={() => setDark(!dark)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
              <a className="icon-btn" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="GitHub 仓库" aria-label="打开 GitHub 仓库"><GitHubIcon size={15} /></a>
            </div>
            <button className="btn-ghost btn-sm" onClick={async () => { await api('/auth/logout', { method: 'POST' }); setMe(null) }}>
              <LogOut size={14} />退出登录
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="scrim mobile-only" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <div className="main-body">
          <header className="topbar">
            <div className="btn-row">
              <button className="icon-btn mobile-only" aria-label="打开导航菜单" onClick={() => setMenuOpen(true)}><Menu size={18} /></button>
              <h1>{currentTitle}</h1>
            </div>
          </header>
          {renderPage()}
        </div>
        <ProjectFooter className="main-footer" />
      </main>
    </div>
  )
}

export function App() {
  return <ToastProvider><Shell /></ToastProvider>
}
