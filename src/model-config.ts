import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'

const CONFIG_PATH = resolve(STORE_DIR, 'model-config.json')

export interface ModelConfig {
  model: string   // 'opus', 'sonnet', 'haiku'
  effort: string  // 'low', 'medium', 'high'
}

const DEFAULT: ModelConfig = { model: 'opus', effort: 'high' }

export function getModelConfig(): ModelConfig {
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return {
      model: data.model || DEFAULT.model,
      effort: data.effort || DEFAULT.effort,
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function setModelConfig(config: Partial<ModelConfig>): ModelConfig {
  const current = getModelConfig()
  const updated = { ...current, ...config }
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2))
  return updated
}

// Fast mode: quick toggle between quality (opus/high) and speed (sonnet/low)
// Inspired by OpenClaw's /fast command
let fastMode = false

export function isFastMode(): boolean {
  return fastMode
}

export function toggleFastMode(): { fast: boolean; model: string; effort: string } {
  fastMode = !fastMode
  const config = fastMode
    ? setModelConfig({ model: 'sonnet', effort: 'low' })
    : setModelConfig({ model: 'opus', effort: 'high' })
  return { fast: fastMode, ...config }
}
