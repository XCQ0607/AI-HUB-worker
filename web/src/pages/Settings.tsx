import { useCallback, useEffect, useState } from 'react'
import { Key, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { api, ago } from '../api'
import { Badge, Card, ConfirmDialog, CopyBtn, EmptyState, Modal, useToast } from '../components/ui'

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [minV, setMinV] = useState('')
  const [fallbackMs, setFallbackMs] = useState('0')
  const [heartbeatMs, setHeartbeatMs] = useState('40000')
  const [curPw, setCurPw] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwConfirm, setPwConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  // Monitor tokens
  const [tokens, setTokens] = useState<any[]>([])
  const [tokName, setTokName] = useState('')
  const [tokOpen, setTokOpen] = useState(false)
  const [createdTok, setCreatedTok] = useState('')
  const [delTok, setDelTok] = useState<any>(null)

  // TOTP 2FA
  const [totp, setTotp] = useState<{ available: boolean; enabled: boolean; recoveryRemaining: number } | null>(null)
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; qrSvg: string } | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [disableOpen, setDisableOpen] = useState(false)
  const [disPw, setDisPw] = useState('')
  const [disCode, setDisCode] = useState('')
  const [reconfigOpen, setReconfigOpen] = useState(false)
  const [reconfigPw, setReconfigPw] = useState('')
  const [reconfigCode, setReconfigCode] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, mt, tp] = await Promise.all([
        api<any>('/settings'),
        api<{ items: any[] }>('/monitor-tokens').catch(() => ({ items: [] })),
        api<any>('/auth/totp/status').catch(() => null),
      ])
      setData(s); setMinV(s.minVersion || ''); setFallbackMs(String(s.mirrorFallbackMs ?? 0)); setHeartbeatMs(String(s.heartbeatMs ?? 40000))
      setTokens(mt.items ?? [])
      if (tp) setTotp(tp)
    } catch (e: any) { toast(e.message, 'error') }
  }, [toast])

  useEffect(() => { load() }, [load])

  const save = async (body: object, okText = '设置已保存') => {
    try { await api('/settings', { method: 'PUT', body }); toast(okText, 'success'); load() }
    catch (e: any) { toast(e.message, 'error') }
  }

  const changePassword = async () => {
    setBusy(true)
    try {
      await api('/admin/password', { body: { currentPassword: curPw, password: pw1 } })
      toast('密码已更新，请重新登录', 'success')
      setPwConfirm(false); setCurPw(''); setPw1(''); setPw2(''); onLogout()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const createMonitorToken = async () => {
    setBusy(true)
    try {
      const r = await api<{ token: string }>('/monitor-tokens', { body: { name: tokName.trim() || 'Uptime Monitor' } })
      setCreatedTok(r.token); setTokName(''); load()
      toast('只读监控令牌已生成', 'success')
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const removeMonitorToken = async () => {
    if (!delTok) return
    setBusy(true)
    try {
      await api(`/monitor-tokens/${encodeURIComponent(delTok.id)}`, { method: 'DELETE' })
      toast('监控令牌已撤销', 'success'); setDelTok(null); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const closeTokModal = () => { setTokOpen(false); setTokName(''); setCreatedTok('') }
  const closeSetupModal = () => { setSetupData(null); setTotpCode(''); setRecoveryCodes([]) }
  const closeDisableModal = () => { setDisableOpen(false); setDisPw(''); setDisCode('') }
  const closeReconfigModal = () => { setReconfigOpen(false); setReconfigPw(''); setReconfigCode('') }

  const startTotpSetup = async (payload?: { password: string; code: string }) => {
    setBusy(true)
    try {
      const r = await api<{ secret: string; uri: string; qrSvg: string }>('/auth/totp/setup', { method: 'POST', body: payload ?? {} })
      closeReconfigModal()
      setSetupData(r); setTotpCode(''); setRecoveryCodes([])
      if (payload) load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const enableTotp = async () => {
    setBusy(true)
    try {
      const r = await api<{ ok: boolean; recoveryCodes: string[] }>('/auth/totp/enable', { body: { code: totpCode } })
      setRecoveryCodes(r.recoveryCodes); setTotpCode(''); toast('两步验证已启用', 'success'); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const disableTotp = async () => {
    setBusy(true)
    try {
      await api('/auth/totp/disable', { body: { password: disPw, code: disCode } })
      toast('两步验证已关闭', 'success'); closeDisableModal(); load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  if (!data) return <p className="muted pad">加载中…</p>

  return (
    <div className="stack">
      <div className="two-col">
        <Card title="准入与版本策略" subtitle="宿主接入要求">
          <div className="form">
            <label>准入模式 {data.modeControlled && <Badge tone="warn">主控端接管中</Badge>}
              <div className="seg">
                {(['open', 'restricted'] as const).map(m => (
                  <button key={m} disabled={data.modeControlled} className={data.mode === m ? 'active' : ''} onClick={() => save({ mode: m })}>
                    {m === 'open' ? '开放模式' : '限制模式'}
                  </button>
                ))}
              </div>
            </label>
            <label>最低插件版本 (X.Y.Z，低于此版本拒绝注册并返回 plugin_too_old)
              <div className="btn-row">
                <input placeholder="留空表示不限制，如 0.5.80" value={minV} onChange={e => setMinV(e.target.value)} />
                <button className="btn-primary" onClick={() => save({ minVersion: minV.trim() })}>保存</button>
              </div>
            </label>
            <label>隧道心跳间隔 (ms，10000–60000，默认 40000 省 DO 唤醒)
              <div className="btn-row">
                <input type="number" min={10000} max={60000} value={heartbeatMs} onChange={e => setHeartbeatMs(e.target.value)} />
                <button className="btn-primary" onClick={() => save({ heartbeatMs: Number(heartbeatMs) || 40000 })}>保存</button>
              </div>
            </label>
          </div>
        </Card>

        <Card title="绑定状态" subtitle="只读；改配置需编辑 env.json 或 wrangler secret">
          <div className="kv-list">
            <div className="kv-row"><span className="muted">隧道注册密钥 (TUNNEL_REGISTER_SECRET)</span>
              <Badge tone={data.registerSecretSet ? 'ok' : 'neutral'}>{data.registerSecretSet ? '已启用校验' : '未设置'}</Badge></div>
            <div className="kv-row"><span className="muted">Cloudflare R2 (BLOB / OTA)</span>
              <Badge tone={data.r2Enabled ? 'ok' : 'warn'}>{data.r2Enabled ? '已绑定' : '未绑定'}</Badge></div>
            <div className="kv-row"><span className="muted">iOS APNs 密钥 (APNS_*)</span>
              <Badge tone={data.apnsEnabled ? 'ok' : 'neutral'}>{data.apnsEnabled ? '已配置' : '未配置'}</Badge></div>
            <div className="kv-row"><span className="muted">OTA 发布令牌 (PLATFORM_OTA_CONTROL_TOKEN)</span>
              <Badge tone={data.otaTokenSet ? 'ok' : 'neutral'}>{data.otaTokenSet ? '已配置' : '仅管理员面板可用'}</Badge></div>
            <div className="kv-row"><span className="muted">联邦角色</span>
              <Badge tone="accent">{data.role === 'slave' ? `被控端 → ${data.masterUrl}` : '主控 / 单机'}</Badge></div>
          </div>
        </Card>
      </div>

      <div className="two-col">
        <Card title="离线镜像策略" subtitle="宿主通过 0x17 帧同步会话与工作区快照">
          <div className="form">
            <label>正文缓存开关
              <div className="seg">
                <button className={data.mirrorEnabled ? 'active' : ''} onClick={() => save({ mirrorEnabled: true })}>开启镜像兜底</button>
                <button className={!data.mirrorEnabled ? 'active' : ''} onClick={() => save({ mirrorEnabled: false })}>仅保留凭据摘要</button>
              </div>
            </label>
            <p className="muted small">
              选择「仅保留凭据摘要」时，中转不再缓存会话/工作区列表正文，但仍保留已配对手机的凭据摘要，以确保 <code>/push-token</code> 与 <code>/blob/*</code> 鉴权正常工作。
            </p>
            <label>慢隧道回退阈值 (ms，0 = 仅断线时兜底)
              <div className="btn-row">
                <input type="number" min={0} max={30000} value={fallbackMs} onChange={e => setFallbackMs(e.target.value)} />
                <button className="btn-primary" onClick={() => save({ mirrorFallbackMs: Number(fallbackMs) || 0 })}>保存</button>
              </div>
            </label>
          </div>
        </Card>

        <Card title="修改管理员密码" subtitle="需校验当前密码；修改后当前全部会话将失效并跳转重新登录">
          <div className="form">
            <label>当前密码<input type="password" autoComplete="current-password" value={curPw} onChange={e => setCurPw(e.target.value)} /></label>
            <label>新密码（至少 12 位）<input type="password" autoComplete="new-password" value={pw1} onChange={e => setPw1(e.target.value)} /></label>
            <label>确认新密码<input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></label>
            <div>
              <button className="btn-primary" onClick={() => {
                if (!curPw) return toast('请输入当前密码', 'error')
                if (pw1.length < 12) return toast('新密码至少需要 12 位', 'error')
                if (pw1 !== pw2) return toast('两次输入的密码不一致', 'error')
                setPwConfirm(true)
              }}>更新密码</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="two-col">
        <Card title="只读 /status 监控令牌" subtitle="用于 Uptime Kuma / Prometheus 轮询 /status 运行指标"
          action={<button className="btn-primary btn-sm" onClick={() => { setCreatedTok(''); setTokName(''); setTokOpen(true) }}><Plus size={14} />生成令牌</button>}>
          {tokens.length === 0 ? <EmptyState title="暂无监控令牌" hint="生成后可通过 Authorization: Bearer 或 ?token= 访问 /status" /> : (
            <div className="table">
              <div className="tr t-mon th"><span>名称</span><span>前缀</span><span>最近使用</span><span /></div>
              {tokens.map(t => (
                <div className="tr t-mon" key={t.id}>
                  <span data-label="名称">{t.name}</span>
                  <code data-label="前缀" className="mono muted">{t.prefix}</code>
                  <span data-label="最近使用" className="muted">{t.lastUsed ? ago(t.lastUsed) : '从未使用'}</span>
                  <span className="actions">
                    <button className="icon-btn danger" title="撤销" aria-label={`撤销监控令牌 ${t.name}`} onClick={() => setDelTok(t)}><Trash2 size={14} /></button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="两步验证 (TOTP 2FA)" subtitle="RFC 6238 动态口令保护，兼容 Google/1Password 验证器"
          action={totp && <Badge tone={totp.enabled ? 'ok' : 'neutral'}>{totp.enabled ? '已启用' : '未启用'}</Badge>}>
          {!totp?.available ? (
            <p className="muted small">当前会话未绑定邮箱管理员账号（<code>ADMIN_TOKEN</code> 仅用于 API / CLI / 初始化引导），仅邮箱密码管理员账号支持绑定 TOTP。</p>
          ) : totp.enabled ? (
            <div className="stack-xs">
              <div className="kv-list">
                <div className="kv-row"><span className="muted">验证器状态</span><Badge tone="ok" icon={<ShieldCheck size={12} />}>已开启保护</Badge></div>
                <div className="kv-row"><span className="muted">剩余一次性恢复码</span><span>{totp.recoveryRemaining} 个</span></div>
              </div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn-ghost btn-sm" onClick={() => { setReconfigPw(''); setReconfigCode(''); setReconfigOpen(true) }}><Key size={14} />重新绑定 2FA</button>
                <button className="btn-danger btn-sm" onClick={() => { setDisPw(''); setDisCode(''); setDisableOpen(true) }}>关闭两步验证</button>
              </div>
            </div>
          ) : (
            <div className="stack-xs">
              <p className="muted small">开启后，每次登录控制台除密码外还需输入 6 位动态验证码（或一次性恢复码）。</p>
              <div><button className="btn-primary btn-sm" disabled={busy} onClick={() => startTotpSetup()}><Key size={14} />立即配置 2FA</button></div>
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog open={pwConfirm} busy={busy} title="确认修改管理员密码"
        description="确认更新当前管理员密码吗？提交后需要用新密码重新登录控制台。" confirmText="确认修改"
        onCancel={() => setPwConfirm(false)} onConfirm={changePassword} />

      <ConfirmDialog open={!!delTok} busy={busy} title="撤销监控令牌"
        description={`确定撤销监控令牌「${delTok?.name}」吗？撤销后使用该令牌的外部探针将立即返回 404。`} confirmText="确认撤销"
        onCancel={() => setDelTok(null)} onConfirm={removeMonitorToken} />

      <Modal open={tokOpen} title="生成只读监控令牌" onClose={closeTokModal}
        footer={createdTok
          ? <button className="btn-primary" onClick={closeTokModal}>我已保存，关闭</button>
          : <><button className="btn-ghost" onClick={closeTokModal}>取消</button><button className="btn-primary" disabled={busy} onClick={createMonitorToken}>生成</button></>}>
        {createdTok ? (
          <div className="stack-xs">
            <p className="small">请立即复制保存，关闭窗口后将无法再次查看明文令牌：</p>
            <div className="kv-row"><code>{createdTok}</code><CopyBtn value={createdTok} label="监控令牌" /></div>
            <div className="code-box"><pre>{`curl -H "Authorization: Bearer ${createdTok}" ${location.origin}/status`}</pre><CopyBtn value={`curl -H "Authorization: Bearer ${createdTok}" ${location.origin}/status`} label="curl 示例" /></div>
          </div>
        ) : (
          <div className="form">
            <label>令牌用途备注<input placeholder="例如：Uptime Kuma 探测" value={tokName} onChange={e => setTokName(e.target.value)} /></label>
          </div>
        )}
      </Modal>

      <Modal open={!!setupData} title={recoveryCodes.length ? '保存一次性恢复码' : '绑定 TOTP 验证器'}
        onClose={closeSetupModal}
        footer={recoveryCodes.length
          ? <button className="btn-primary" onClick={closeSetupModal}>我已妥善保存</button>
          : <><button className="btn-ghost" onClick={closeSetupModal}>取消</button><button className="btn-primary" disabled={busy} onClick={enableTotp}>验证并启用</button></>}>
        {setupData && (recoveryCodes.length ? (
          <div className="stack-xs">
            <p className="small">以下恢复码仅显示一次，丢失手机验证器时可用于登录：</p>
            <div className="code-box"><pre>{recoveryCodes.join('\n')}</pre><CopyBtn value={recoveryCodes.join('\n')} label="恢复码" /></div>
          </div>
        ) : (
          <div className="form">
            {setupData.qrSvg ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setupData.qrSvg)}`} alt="TOTP QR" style={{ width: 176, height: 176, borderRadius: 10, border: '1px solid var(--line)' }} />
              </div>
            ) : (
              <div className="banner">
                <span className="small">当前账号 URI 超过内置二维码容量上限，请使用下方手动密钥或复制 otpauth URI 导入验证器。</span>
              </div>
            )}
            <div className="kv-row"><span className="muted">手动密钥 (Base32)</span><div className="kv-val"><code>{setupData.secret}</code><CopyBtn value={setupData.secret} label="Base32 密钥" /></div></div>
            {!setupData.qrSvg && (
              <div className="kv-row"><span className="muted">otpauth URI</span><div className="kv-val"><code className="ellipsis">{setupData.uri}</code><CopyBtn value={setupData.uri} label="otpauth URI" /></div></div>
            )}
            <label>输入验证器显示的 6 位数字
              <input value={totpCode} onChange={e => setTotpCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) enableTotp() }} placeholder="123456" autoFocus />
            </label>
          </div>
        ))}
      </Modal>

      <Modal open={reconfigOpen} title="验证身份以重新绑定 2FA" onClose={closeReconfigModal}
        footer={<><button className="btn-ghost" onClick={closeReconfigModal}>取消</button><button className="btn-primary" disabled={busy} onClick={() => startTotpSetup({ password: reconfigPw, code: reconfigCode })}>验证并生成新密钥</button></>}>
        <div className="form">
          <div className="banner"><span className="small">验证通过后将生成待绑定新密钥；在新密钥验证启用前，当前已启用的两步验证仍保持生效，取消操作不会关闭 2FA。</span></div>
          <label>当前管理员密码<input type="password" value={reconfigPw} onChange={e => setReconfigPw(e.target.value)} autoFocus /></label>
          <label>6 位动态验证码或 8 位恢复码<input value={reconfigCode} onChange={e => setReconfigCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) startTotpSetup({ password: reconfigPw, code: reconfigCode }) }} placeholder="123456 或 ABCD-EF12" /></label>
        </div>
      </Modal>

      <Modal open={disableOpen} title="关闭两步验证" onClose={closeDisableModal}
        footer={<><button className="btn-ghost" onClick={closeDisableModal}>取消</button><button className="btn-danger" disabled={busy} onClick={disableTotp}>确认关闭</button></>}>
        <div className="form">
          <label>当前管理员密码<input type="password" value={disPw} onChange={e => setDisPw(e.target.value)} /></label>
          <label>6 位动态验证码或 8 位恢复码<input value={disCode} onChange={e => setDisCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) disableTotp() }} placeholder="123456 或 ABCD-EF12" /></label>
        </div>
      </Modal>
    </div>
  )
}
