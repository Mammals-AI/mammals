import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads')

// Ensure uploads dir exists
mkdirSync(UPLOADS_DIR, { recursive: true })

/**
 * Download a file from Telegram's servers.
 * Returns the local file path.
 */
export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  // Step 1: Get file path from Telegram
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
  const info = await infoRes.json() as { ok: boolean; result: { file_path: string } }
  if (!info.ok) throw new Error('Failed to get file info from Telegram')

  // Step 2: Download the file
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`
  const fileRes = await fetch(fileUrl)
  if (!fileRes.ok) throw new Error('Failed to download file from Telegram')

  const buffer = Buffer.from(await fileRes.arrayBuffer())

  // Reject HTML responses masquerading as image files (e.g. Cloudflare challenge pages)
  const preview = buffer.slice(0, 100).toString('utf8').trimStart().toLowerCase()
  if (preview.startsWith('<!doctype') || preview.startsWith('<html')) {
    throw new Error('Downloaded file is HTML, not a valid image — possible Cloudflare block or bad URL')
  }

  // Step 3: Save locally with sanitized filename
  const rawName = originalFilename ?? info.result.file_path.split('/').pop() ?? 'file'
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  writeFileSync(localPath, buffer)
  logger.debug({ localPath, bytes: buffer.length }, 'Downloaded media')

  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo attached: ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please analyze this image.')
  return parts.join('\n')
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const parts = [`[Document attached: ${localPath} (${filename})]`]
  if (caption) parts.push(caption)
  parts.push('Please read and analyze this document.')
  return parts.join('\n')
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [`[Video attached: ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please analyze this video using the GOOGLE_API_KEY from the .env file and the Gemini API.')
  return parts.join('\n')
}

/**
 * Delete uploaded files older than maxAgeMs (default 24 hours).
 */
export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const now = Date.now()
    const files = readdirSync(UPLOADS_DIR)
    let cleaned = 0
    for (const file of files) {
      const filePath = resolve(UPLOADS_DIR, file)
      const stat = statSync(filePath)
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath)
        cleaned++
      }
    }
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old upload(s)`)
    }
  } catch {
    // uploads dir might not exist yet, that's fine
  }
}
