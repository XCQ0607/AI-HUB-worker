// AUTO-GENERATED from protocol/upstream.lock.json — DO NOT EDIT.
// Upstream: WNLUO/dsh-mobile-server@aa8e96a9a613897487a28940a4701473c1ca52c2 (relay v0.1.32)

export const UPSTREAM_COMMIT = 'aa8e96a9a613897487a28940a4701473c1ca52c2'
export const UPSTREAM_RELAY_VERSION = '0.1.32'

export const T = {
  register: 0x01,
  registered: 0x02,
  updatePairing: 0x03,
  httpRequest: 0x04,
  httpBody: 0x05,
  httpHead: 0x06,
  httpChunk: 0x07,
  httpEnd: 0x08,
  httpError: 0x09,
  wsUpgrade: 0x0a,
  wsOpen: 0x0b,
  wsError: 0x0c,
  wsText: 0x0d,
  wsBinary: 0x0e,
  wsClose: 0x0f,
  ping: 0x10,
  pong: 0x11,
  pairRequest: 0x12,
  pairConfirm: 0x13,
  httpCancel: 0x14,
  httpPause: 0x15,
  httpResume: 0x16,
  sync: 0x17,
  revokeAll: 0x18,
  revokeAllAck: 0x19,
  migrate: 0x1c,
  blobPut: 0x1d,
  blobDelete: 0x1e,
} as const

export const HEADER_LEN = 9
export const RESERVED_CLOSE_CODES: readonly number[] = [1004, 1005, 1006, 1015]
export const OWNED_PATHS: readonly string[] = ['/', '/healthz', '/status', '/api/mobile/v1/health', '/tunnel']
export const MOBILE_PREFIX = '/api/mobile/v1/'
