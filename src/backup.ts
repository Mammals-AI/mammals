/**
 * Backup & restore system — inspired by OpenClaw's openclaw backup create/verify.
 * Creates timestamped archives of the DB, .env, and config files.
 * Supports selective restore and verification.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from './config.js'
import { logger } from './logger.js'

/**
 * Recursively copy a directory, skipping sockets and other special files.
 * Returns an array of relative paths (from basePrefix) that were copied.
 */
function copyDirRecursive(src: string, dest: string, basePrefix: string): string[] {
  const copied: string[] = []
  mkdirSync(dest, { recursive: true })

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const relPath = basePrefix ? `${basePrefix}/${entry}` : entry
    const stat = statSync(srcPath)

    if (stat.isDirectory()) {
      // Recurse into subdirectories
      copied.push(...copyDirRecursive(srcPath, destPath, relPath))
    } else if (stat.isFile()) {
      // Regular file — safe to copy
      copyFileSync(srcPath, destPath)
      copied.push(relPath)
    } else {
      // Socket, FIFO, device, etc. — skip
      logger.debug({ path: srcPath, type: 'special' }, 'Skipping non-regular file in backup')
    }
  }

  return copied
}

const BACKUP_DIR = resolve(STORE_DIR, 'backups')
const DB_FILE = resolve(STORE_DIR, 'claudeclaw.db')
const ENV_FILE = resolve(PROJECT_ROOT, '.env')
const MAX_BACKUPS = 10  // auto-prune older backups

interface BackupManifest {
  timestamp: string
  version: string
  files: string[]
  dbSizeBytes: number
}

/**
 * Create a timestamped backup of DB + .env + CLAUDE.md
 */
export function createBackup(): { path: string; manifest: BackupManifest } {
  mkdirSync(BACKUP_DIR, { recursive: true })

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = resolve(BACKUP_DIR, `backup-${ts}`)
  mkdirSync(backupPath)

  const files: string[] = []

  // 1. Backup DB using SQLite's .backup command (safe even during writes)
  if (existsSync(DB_FILE)) {
    const destDb = resolve(backupPath, 'claudeclaw.db')
    try {
      execSync(`sqlite3 "${DB_FILE}" ".backup '${destDb}'"`)
      files.push('claudeclaw.db')
    } catch {
      // Fallback: raw copy (less safe but better than nothing)
      copyFileSync(DB_FILE, destDb)
      files.push('claudeclaw.db')
    }
  }

  // 2. Backup .env
  if (existsSync(ENV_FILE)) {
    copyFileSync(ENV_FILE, resolve(backupPath, '.env'))
    files.push('.env')
  }

  // 3. Backup CLAUDE.md
  const claudeMd = resolve(PROJECT_ROOT, 'CLAUDE.md')
  if (existsSync(claudeMd)) {
    copyFileSync(claudeMd, resolve(backupPath, 'CLAUDE.md'))
    files.push('CLAUDE.md')
  }

  // 4. Backup skills directory (recursive, skips sockets/special files)
  const skillsDir = resolve(PROJECT_ROOT, 'skills')
  if (existsSync(skillsDir)) {
    const destSkills = resolve(backupPath, 'skills')
    const copied = copyDirRecursive(skillsDir, destSkills, 'skills')
    files.push(...copied)
  }

  // Write manifest
  const manifest: BackupManifest = {
    timestamp: new Date().toISOString(),
    version: '1.0',
    files,
    dbSizeBytes: existsSync(DB_FILE) ? statSync(DB_FILE).size : 0,
  }

  const manifestPath = resolve(backupPath, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // Prune old backups
  pruneBackups()

  logger.info({ path: backupPath, files: files.length }, 'Backup created')
  return { path: backupPath, manifest }
}

/**
 * Verify a backup is intact by checking manifest against actual files.
 */
export function verifyBackup(backupPath: string): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const manifestPath = resolve(backupPath, 'manifest.json')

  if (!existsSync(manifestPath)) {
    return { ok: false, errors: ['manifest.json missing'] }
  }

  const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

  for (const file of manifest.files) {
    const filePath = resolve(backupPath, file)
    if (!existsSync(filePath)) {
      errors.push(`Missing: ${file}`)
    }
  }

  // Check DB integrity if present
  const dbPath = resolve(backupPath, 'claudeclaw.db')
  if (existsSync(dbPath)) {
    try {
      const result = execSync(`sqlite3 "${dbPath}" "PRAGMA integrity_check"`, { encoding: 'utf-8' }).trim()
      if (result !== 'ok') {
        errors.push(`DB integrity check failed: ${result}`)
      }
    } catch (err) {
      errors.push(`DB integrity check error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * List all available backups, newest first.
 */
export function listBackups(): Array<{ name: string; path: string; timestamp: string; files: number; dbSize: number }> {
  if (!existsSync(BACKUP_DIR)) return []

  return readdirSync(BACKUP_DIR)
    .filter(d => d.startsWith('backup-'))
    .map(d => {
      const path = resolve(BACKUP_DIR, d)
      const manifestPath = resolve(path, 'manifest.json')
      if (!existsSync(manifestPath)) return null
      try {
        const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        return {
          name: d,
          path,
          timestamp: manifest.timestamp,
          files: manifest.files.length,
          dbSize: manifest.dbSizeBytes,
        }
      } catch {
        return null
      }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

/**
 * Keep only the most recent MAX_BACKUPS backups.
 */
function pruneBackups(): void {
  const backups = listBackups()
  if (backups.length <= MAX_BACKUPS) return

  const toRemove = backups.slice(MAX_BACKUPS)
  for (const backup of toRemove) {
    try {
      execSync(`rm -rf "${backup.path}"`)
      logger.info({ backup: backup.name }, 'Pruned old backup')
    } catch {
      // ignore cleanup errors
    }
  }
}
