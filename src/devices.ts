/**
 * Device Integration — Mac-specific capabilities (OpenClaw-inspired).
 *
 * Provides access to:
 * - Screenshots (screencapture)
 * - Camera photos (imagesnap or ffmpeg)
 * - System notifications (osascript)
 * - Screen recording (screencapture -v)
 * - System info (location approximation via networksetup, battery, etc.)
 *
 * All operations use native macOS tools — no extra dependencies needed.
 */

import { execSync, exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const CAPTURE_DIR = resolve(STORE_DIR, 'captures')

// Ensure capture directory exists
function ensureCaptureDir(): void {
  mkdirSync(CAPTURE_DIR, { recursive: true })
}

/**
 * Take a screenshot of the entire screen.
 * Returns the path to the saved PNG file.
 */
export function takeScreenshot(displayId?: number): string {
  ensureCaptureDir()
  const filename = `screenshot-${Date.now()}.png`
  const filepath = resolve(CAPTURE_DIR, filename)

  const displayArg = displayId !== undefined ? `-D ${displayId}` : ''
  execSync(`screencapture -x ${displayArg} "${filepath}"`, { timeout: 10_000 })

  if (!existsSync(filepath)) {
    throw new Error('Screenshot failed — file not created')
  }

  logger.info({ path: filepath }, 'Screenshot taken')
  return filepath
}

/**
 * Take a screenshot of a specific window (the frontmost window).
 */
export function screenshotWindow(): string {
  ensureCaptureDir()
  const filename = `window-${Date.now()}.png`
  const filepath = resolve(CAPTURE_DIR, filename)

  // -l flag captures a specific window, -w waits for window click,
  // but we want non-interactive: capture frontmost window
  execSync(`screencapture -x -l $(osascript -e 'tell application "System Events" to get id of first window of first application process whose frontmost is true') "${filepath}"`, {
    timeout: 10_000,
    shell: '/bin/zsh',
  })

  if (!existsSync(filepath)) {
    // Fallback to basic screenshot if window capture fails
    return takeScreenshot()
  }

  logger.info({ path: filepath }, 'Window screenshot taken')
  return filepath
}

/**
 * Capture a photo from the Mac's camera.
 * Uses imagesnap if available, falls back to ffmpeg.
 */
export function captureCamera(): string {
  ensureCaptureDir()
  const filename = `camera-${Date.now()}.jpg`
  const filepath = resolve(CAPTURE_DIR, filename)

  // Try imagesnap first (brew install imagesnap)
  try {
    execSync(`which imagesnap`, { stdio: 'ignore' })
    // -w 1 = warm up camera for 1 second
    execSync(`imagesnap -w 1 "${filepath}"`, { timeout: 15_000 })
    if (existsSync(filepath)) {
      logger.info({ path: filepath }, 'Camera photo captured (imagesnap)')
      return filepath
    }
  } catch {
    // imagesnap not installed, try ffmpeg
  }

  // Fallback: ffmpeg with AVFoundation
  try {
    execSync(`ffmpeg -f avfoundation -framerate 30 -video_size 1280x720 -i "0" -frames:v 1 -y "${filepath}" 2>/dev/null`, {
      timeout: 15_000,
      shell: '/bin/zsh',
    })
    if (existsSync(filepath)) {
      logger.info({ path: filepath }, 'Camera photo captured (ffmpeg)')
      return filepath
    }
  } catch {
    // ffmpeg failed too
  }

  throw new Error('Camera capture failed — install imagesnap (brew install imagesnap) or ffmpeg')
}

/**
 * Send a macOS notification.
 */
export function sendNotification(title: string, message: string, sound = 'default'): void {
  const escapedTitle = title.replace(/"/g, '\\"')
  const escapedMsg = message.replace(/"/g, '\\"')

  execSync(
    `osascript -e 'display notification "${escapedMsg}" with title "${escapedTitle}" sound name "${sound}"'`,
    { timeout: 5_000 }
  )
  logger.info({ title }, 'Notification sent')
}

/**
 * Start a screen recording. Returns the PID so it can be stopped later.
 * Saves to the captures directory.
 */
export function startScreenRecording(): { pid: number; filepath: string } {
  ensureCaptureDir()
  const filename = `recording-${Date.now()}.mov`
  const filepath = resolve(CAPTURE_DIR, filename)

  const proc = exec(`screencapture -v "${filepath}"`)

  if (!proc.pid) {
    throw new Error('Failed to start screen recording')
  }

  logger.info({ pid: proc.pid, path: filepath }, 'Screen recording started')
  return { pid: proc.pid, filepath }
}

/**
 * Stop a screen recording by PID.
 */
export function stopScreenRecording(pid: number): void {
  try {
    process.kill(pid, 'SIGINT')  // screencapture saves on SIGINT
    logger.info({ pid }, 'Screen recording stopped')
  } catch (err) {
    logger.warn({ err, pid }, 'Failed to stop screen recording')
  }
}

/**
 * Get system information: uptime, CPU, memory, disk, battery.
 */
export function getSystemInfo(): Record<string, string> {
  const info: Record<string, string> = {}

  try {
    info.uptime = execSync('uptime', { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }

  try {
    const memRaw = execSync("vm_stat | head -5", { encoding: 'utf-8' })
    info.memory = memRaw.trim()
  } catch { /* ignore */ }

  try {
    info.disk = execSync("df -h / | tail -1", { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }

  try {
    info.cpu = execSync("sysctl -n machdep.cpu.brand_string", { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }

  try {
    // Battery info (if on a laptop — Mac Mini won't have this)
    const battery = execSync("pmset -g batt 2>/dev/null || echo 'No battery'", { encoding: 'utf-8' }).trim()
    info.battery = battery
  } catch { /* ignore */ }

  try {
    info.hostname = execSync('hostname', { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }

  return info
}

/**
 * Get the current Wi-Fi network name.
 */
export function getWifiNetwork(): string | null {
  try {
    const result = execSync(
      '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I | grep " SSID"',
      { encoding: 'utf-8' }
    ).trim()
    const match = result.match(/SSID:\s*(.+)/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/**
 * Get a rough location based on the external IP (no GPS needed).
 */
export async function getApproxLocation(): Promise<{ city?: string; region?: string; country?: string; ip?: string } | null> {
  try {
    const response = await fetch('http://ip-api.com/json/?fields=city,regionName,country,query', {
      signal: AbortSignal.timeout(5_000),
    })
    const data = await response.json() as Record<string, string>
    return {
      city: data.city,
      region: data.regionName,
      country: data.country,
      ip: data.query,
    }
  } catch {
    return null
  }
}

/**
 * Copy text to the macOS clipboard.
 */
export function copyToClipboard(text: string): void {
  execSync('pbcopy', { input: text, timeout: 3_000 })
}

/**
 * Read text from the macOS clipboard.
 */
export function readClipboard(): string {
  return execSync('pbpaste', { encoding: 'utf-8', timeout: 3_000 })
}

/**
 * Clean up old capture files (older than 24 hours).
 */
export function cleanupCaptures(): number {
  if (!existsSync(CAPTURE_DIR)) return 0
  try {
    const result = execSync(
      `find "${CAPTURE_DIR}" -type f -mtime +1 -delete -print | wc -l`,
      { encoding: 'utf-8', shell: '/bin/zsh' }
    ).trim()
    const count = parseInt(result, 10) || 0
    if (count > 0) logger.info({ count }, 'Cleaned up old captures')
    return count
  } catch {
    return 0
  }
}

/**
 * Get a summary of all device capabilities.
 */
export function deviceCapabilities(): Record<string, boolean> {
  const caps: Record<string, boolean> = {
    screenshot: true,  // screencapture is always available on macOS
    notification: true,  // osascript always available
    clipboard: true,
    systemInfo: true,
  }

  // Check optional tools
  try {
    execSync('which imagesnap', { stdio: 'ignore' })
    caps.camera = true
  } catch {
    try {
      execSync('which ffmpeg', { stdio: 'ignore' })
      caps.camera = true
    } catch {
      caps.camera = false
    }
  }

  caps.screenRecording = true  // screencapture -v available on macOS

  return caps
}
