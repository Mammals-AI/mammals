/**
 * Pairing Security — short-lived tokens for device authentication (OpenClaw-inspired).
 *
 * Instead of a permanent API token, devices get a short-lived pairing token:
 * 1. The owner requests a pairing code via /pair in Telegram
 * 2. The device sends the code to the API within the time window
 * 3. On success, the device gets a long-lived session token
 * 4. Session tokens can be revoked individually
 *
 * This is more secure than a permanent bearer token because:
 * - Pairing codes expire quickly (5 minutes)
 * - Each device gets its own token (can be revoked individually)
 * - No shared secret to leak
 */

import { randomBytes } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000  // 5 minutes
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

interface PairingCode {
  code: string
  device_name: string
  created_at: number
  expires_at: number
}

export interface DeviceSession {
  id: string
  device_name: string
  token: string
  created_at: number
  expires_at: number
  last_used_at: number
}

/**
 * Initialize the pairing tables.
 */
export function initPairing(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS device_sessions (
      id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )
  `)

  // Clean up expired codes on init
  cleanupExpired()
}

/**
 * Generate a short pairing code for a device.
 * Returns a 6-character alphanumeric code.
 */
export function createPairingCode(deviceName: string): PairingCode {
  const d = getDb()
  const now = Date.now()

  // Clean up any existing codes for this device
  d.prepare('DELETE FROM pairing_codes WHERE device_name = ?').run(deviceName)

  // Generate a 6-char code (easy to type)
  const code = randomBytes(3).toString('hex').toUpperCase()
  const expiresAt = now + PAIRING_CODE_TTL_MS

  d.prepare(`
    INSERT INTO pairing_codes (code, device_name, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(code, deviceName, now, expiresAt)

  logger.info({ device: deviceName, code }, 'Pairing code created')

  return { code, device_name: deviceName, created_at: now, expires_at: expiresAt }
}

/**
 * Validate a pairing code and create a device session.
 * Returns the session token on success, null if invalid/expired.
 */
export function redeemPairingCode(code: string): DeviceSession | null {
  const d = getDb()
  const now = Date.now()

  const row = d.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code) as PairingCode | undefined
  if (!row) return null
  if (now > row.expires_at) {
    // Expired — clean it up
    d.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code)
    return null
  }

  // Code is valid — delete it (one-time use)
  d.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code)

  // Create a session token
  const id = randomBytes(8).toString('hex')
  const token = randomBytes(32).toString('hex')
  const expiresAt = now + SESSION_TOKEN_TTL_MS

  const session: DeviceSession = {
    id,
    device_name: row.device_name,
    token,
    created_at: now,
    expires_at: expiresAt,
    last_used_at: now,
  }

  d.prepare(`
    INSERT INTO device_sessions (id, device_name, token, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, row.device_name, token, now, expiresAt, now)

  logger.info({ device: row.device_name, sessionId: id }, 'Device paired successfully')
  return session
}

/**
 * Validate a session token. Returns the session if valid, null if not.
 * Updates last_used_at on successful validation.
 */
export function validateToken(token: string): DeviceSession | null {
  const d = getDb()
  const now = Date.now()

  const row = d.prepare('SELECT * FROM device_sessions WHERE token = ?').get(token) as DeviceSession | undefined
  if (!row) return null
  if (now > row.expires_at) {
    // Expired — clean up
    d.prepare('DELETE FROM device_sessions WHERE id = ?').run(row.id)
    return null
  }

  // Update last used
  d.prepare('UPDATE device_sessions SET last_used_at = ? WHERE id = ?').run(now, row.id)

  return row
}

/**
 * List all active device sessions.
 */
export function listDevices(): DeviceSession[] {
  const d = getDb()
  const now = Date.now()
  // Only return non-expired sessions
  return d.prepare('SELECT * FROM device_sessions WHERE expires_at > ? ORDER BY last_used_at DESC')
    .all(now) as DeviceSession[]
}

/**
 * Revoke a specific device session.
 */
export function revokeDevice(idOrName: string): boolean {
  const d = getDb()
  // Try by ID first, then by device name
  let result = d.prepare('DELETE FROM device_sessions WHERE id = ?').run(idOrName)
  if (result.changes === 0) {
    result = d.prepare('DELETE FROM device_sessions WHERE device_name = ?').run(idOrName)
  }
  if (result.changes > 0) {
    logger.info({ device: idOrName }, 'Device session revoked')
    return true
  }
  return false
}

/**
 * Revoke all device sessions.
 */
export function revokeAllDevices(): number {
  const d = getDb()
  const result = d.prepare('DELETE FROM device_sessions').run()
  logger.info({ count: result.changes }, 'All device sessions revoked')
  return result.changes
}

/**
 * Clean up expired pairing codes and sessions.
 */
function cleanupExpired(): void {
  const d = getDb()
  const now = Date.now()
  d.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(now)
  d.prepare('DELETE FROM device_sessions WHERE expires_at < ?').run(now)
}
