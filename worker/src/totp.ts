import { ctEq } from './protocol'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function b32Encode(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = ''
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}

export function b32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, val = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) continue
    val = (val << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function genTotpSecret(): string {
  const buf = new Uint8Array(20)
  crypto.getRandomValues(buf)
  return b32Encode(buf)
}

export function genRecoveryCodes(count = 8): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const b = new Uint8Array(8)
    crypto.getRandomValues(b)
    let code = ''
    for (let j = 0; j < 8; j++) {
      if (j === 4) code += '-'
      code += chars[b[j] % chars.length]
    }
    out.push(code)
  }
  return out
}

export function buildOtpAuthUri(email: string, secret: string, issuer = 'AI-HUB'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

async function hotp(keyBytes: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const buf = new ArrayBuffer(8)
  const dv = new DataView(buf)
  dv.setUint32(0, Math.floor(counter / 0x1_0000_0000))
  dv.setUint32(4, counter >>> 0)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
  const offset = sig[sig.length - 1] & 0x0f
  const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

export async function verifyTotpStep(
  secretBase32: string,
  code: string,
  lastStep?: number | null,
  now = Date.now(),
): Promise<number | null> {
  const clean = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const key = b32Decode(secretBase32)
  if (!key.length) return null
  const step = Math.floor(now / 1000 / 30)
  let matched: number | null = null
  for (let d = -1; d <= 1; d++) {
    const candidate = step + d
    const expected = await hotp(key, candidate)
    if (ctEq(expected, clean)) matched = candidate
  }
  if (matched === null) return null
  if (lastStep != null && matched <= lastStep) return null
  return matched
}

export async function verifyTotpCode(secretBase32: string, code: string, now = Date.now()): Promise<boolean> {
  return (await verifyTotpStep(secretBase32, code, null, now)) !== null
}

// ---- Minimal ISO 18004 QR Code SVG generator (Byte mode, EC Level L, Versions 1..8) ----
const QR_VER_L: Array<{ cap: number; ec: number; blocks: number; align: number[] }> = [
  { cap: 17, ec: 7, blocks: 1, align: [] },           // v1 (21x21)
  { cap: 32, ec: 10, blocks: 1, align: [6, 18] },     // v2 (25x25)
  { cap: 53, ec: 15, blocks: 1, align: [6, 22] },     // v3 (29x29)
  { cap: 78, ec: 20, blocks: 1, align: [6, 26] },     // v4 (33x33)
  { cap: 106, ec: 26, blocks: 1, align: [6, 30] },    // v5 (37x37)
  { cap: 134, ec: 18, blocks: 2, align: [6, 34] },    // v6 (41x41)
  { cap: 154, ec: 20, blocks: 2, align: [6, 22, 38] },// v7 (45x45)
  { cap: 192, ec: 24, blocks: 2, align: [6, 24, 42] },// v8 (49x49)
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])

function rsGenPoly(deg: number): number[] {
  let g = [1]
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0)
    const f = GF_EXP[i]
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= gfMul(g[j], f)
    }
    g = next
  }
  return g
}

function rsRemainder(data: number[], ecLen: number): number[] {
  const gen = rsGenPoly(ecLen)
  const rem = [...data, ...new Array(ecLen).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const coef = rem[i]
    if (coef === 0) continue
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], coef)
  }
  return rem.slice(data.length)
}

export function renderQrSvg(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const vi = QR_VER_L.findIndex(v => bytes.length <= v.cap)
  if (vi < 0) return ''
  const ver = vi + 1
  const spec = QR_VER_L[vi]
  const size = 17 + ver * 4

  const bits: number[] = []
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  pushBits(0b0100, 4) // Byte mode
  pushBits(bytes.length, 8) // v1..v9 use 8-bit char count
  for (const b of bytes) pushBits(b, 8)
  const totalDataBits = (spec.cap + 2) * 8
  pushBits(0, Math.min(4, totalDataBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  let pad = 0
  while (bits.length < totalDataBits) {
    pushBits(pad++ % 2 === 0 ? 0xec : 0x11, 8)
  }

  const dataBytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataBytes.push(b)
  }

  const blockSize = Math.floor(dataBytes.length / spec.blocks)
  const extra = dataBytes.length % spec.blocks
  const dBlocks: number[][] = []
  const eBlocks: number[][] = []
  let off = 0
  for (let b = 0; b < spec.blocks; b++) {
    const len = blockSize + (b >= spec.blocks - extra ? 1 : 0)
    const db = dataBytes.slice(off, off + len)
    off += len
    dBlocks.push(db)
    eBlocks.push(rsRemainder(db, spec.ec))
  }

  const codewords: number[] = []
  const maxD = Math.max(...dBlocks.map(d => d.length))
  for (let i = 0; i < maxD; i++) for (const d of dBlocks) if (i < d.length) codewords.push(d[i])
  for (let i = 0; i < spec.ec; i++) for (const e of eBlocks) codewords.push(e[i])

  const mod = Array.from({ length: size }, () => new Int8Array(size).fill(-1))
  const fn = Array.from({ length: size }, () => new Uint8Array(size))
  const setFn = (r: number, c: number, v: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) { mod[r][c] = v; fn[r][c] = 1 }
  }
  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inB = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const v = inB && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)) ? 1 : 0
        setFn(r0 + dr, c0 + dc, v)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  for (const r of spec.align) {
    for (const c of spec.align) {
      if (fn[r][c]) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0)
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0 ? 1 : 0)
    setFn(i, 6, i % 2 === 0 ? 1 : 0)
  }
  setFn(size - 8, 8, 1)

  // Reserve format info + version info (>=7)
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { fn[8][i] = 1; fn[i][8] = 1 }
    if (i < 8) { fn[8][size - 1 - i] = 1; fn[size - 1 - i][8] = 1 }
  }
  if (ver >= 7) {
    // Version 7 and 8 fixed 18-bit BCH version info
    const vInfo = ver === 7 ? 0x07c94 : 0x085bc
    for (let i = 0; i < 18; i++) {
      const bit = (vInfo >>> i) & 1
      const a = Math.floor(i / 3), b = size - 11 + (i % 3)
      setFn(a, b, bit); setFn(b, a, bit)
    }
  }

  // Place data bits with mask 0: (r + c) % 2 === 0
  let bitIdx = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j
        const upward = ((right + 1) & 2) === 0
        const r = upward ? size - 1 - vert : vert
        if (fn[r][c]) continue
        let b = 0
        if (bitIdx < totalBits) b = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1
        bitIdx++
        mod[r][c] = b ^ ((r + c) % 2 === 0 ? 1 : 0)
      }
    }
  }

  // Format info for EC Level L (01) + mask 0 (000) => 0x77c4 (15 bits, MSB first)
  const fmt = 0x77c4
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> (14 - i)) & 1
    if (i < 6) mod[8][i] = bit
    else if (i === 6) mod[8][7] = bit
    else if (i === 7) mod[8][8] = bit
    else if (i === 8) mod[7][8] = bit
    else mod[14 - i][8] = bit

    if (i < 7) mod[size - 1 - i][8] = bit
    else mod[8][size - 15 + i] = bit
  }

  let d = ''
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mod[r][c] === 1) d += `M${c + 2},${r + 2}h1v1h-1z`
    }
  }
  const vb = size + 4
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}" shape-rendering="crispEdges"><rect width="${vb}" height="${vb}" fill="#ffffff"/><path d="${d}" fill="#0f172a"/></svg>`
}
