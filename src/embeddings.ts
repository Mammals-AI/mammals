/**
 * Ollama-based vector embeddings for semantic memory search.
 * Uses nomic-embed-text model running locally.
 */

import { logger } from './logger.js'

const OLLAMA_URL = 'http://localhost:11434'
const EMBED_MODEL = 'nomic-embed-text'

/**
 * Generate an embedding vector for a piece of text via Ollama.
 * Returns a Float32Array, or null if Ollama isn't available.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Ollama embed request failed')
      return null
    }

    const data = await res.json() as { embeddings?: number[][] }
    if (!data.embeddings?.[0]) return null

    return new Float32Array(data.embeddings[0])
  } catch (err) {
    // Ollama not running — silently degrade to keyword-only search
    logger.debug({ err }, 'Ollama unavailable for embeddings')
    return null
  }
}

/**
 * Cosine similarity between two vectors. Returns 0-1 (higher = more similar).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0

  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

/**
 * Deserialize a Buffer from SQLite back to a Float32Array.
 */
export function bufferToEmbedding(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length)
  new Uint8Array(ab).set(buf)
  return new Float32Array(ab)
}

/**
 * Check if Ollama is running and has the embedding model.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return false
    const data = await res.json() as { models?: { name: string }[] }
    return data.models?.some(m => m.name.startsWith(EMBED_MODEL)) ?? false
  } catch {
    return false
  }
}
