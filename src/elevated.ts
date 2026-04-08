/**
 * Elevated Mode — per-session permission toggle (OpenClaw-inspired).
 * When OFF (default), dangerous commands require confirmation.
 * When ON, all commands execute immediately without confirmation.
 *
 * This gives the owner a quick way to toggle safety checks when they know
 * he's doing something destructive on purpose.
 */

import { getBotConfig, setBotConfig } from './db.js'
import { logger } from './logger.js'

const ELEVATED_KEY = 'elevated_mode'

// Dangerous command patterns that require confirmation in normal mode
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bkill\s+-9\b/i,
  /\bsudo\s+rm\b/i,
  /\bformat\b/i,
  /\btruncate\b/i,
  /\blaunchctl\s+(stop|unload)\s+com\.claudeclaw/i,
]

// Financial patterns — always require confirmation regardless of elevated mode
const FINANCIAL_PATTERNS = [
  /\b(buy|sell|trade|purchase|spend|pay|transfer|swap)\b/i,
]

export function isElevated(): boolean {
  const val = getBotConfig(ELEVATED_KEY)
  return val === 'true'
}

export function setElevated(enabled: boolean): boolean {
  setBotConfig(ELEVATED_KEY, enabled ? 'true' : 'false')
  logger.info({ elevated: enabled }, `Elevated mode ${enabled ? 'ON' : 'OFF'}`)
  return enabled
}

export function toggleElevated(): boolean {
  const current = isElevated()
  return setElevated(!current)
}

/**
 * Check if a message contains a dangerous command that needs confirmation.
 * Returns true if confirmation is needed (not elevated + dangerous command).
 * Financial actions ALWAYS need confirmation regardless of mode.
 */
export function needsElevatedConfirmation(message: string): { needed: boolean; reason?: string } {
  // Financial stuff — always confirm
  if (FINANCIAL_PATTERNS.some(p => p.test(message))) {
    return { needed: true, reason: 'financial action — always requires confirmation' }
  }

  // If elevated, skip danger checks
  if (isElevated()) {
    return { needed: false }
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(message)) {
      return { needed: true, reason: `matches dangerous pattern: ${pattern.source}` }
    }
  }

  return { needed: false }
}

/**
 * Get status summary for display.
 */
export function elevatedStatus(): { elevated: boolean; description: string } {
  const on = isElevated()
  return {
    elevated: on,
    description: on
      ? 'ON — dangerous commands execute without confirmation'
      : 'OFF — dangerous commands require confirmation (default)',
  }
}
