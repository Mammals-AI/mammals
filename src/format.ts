/**
 * Telegram message formatting utilities.
 * Extracted for testability and reuse across bot.ts and api.ts.
 */

import { MAX_MESSAGE_LENGTH } from './config.js'

export function formatForTelegram(text: string): string {
  // Protect code blocks first
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `%%CB${idx}%%`
  })

  // Protect inline code
  const inlineCode: string[] = []
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCode.length
    inlineCode.push(`<code>${escapeHtml(code)}</code>`)
    return `%%IC${idx}%%`
  })

  // Escape HTML in remaining text
  result = escapeHtml(result)

  // Markdown → HTML conversions
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')       // headings
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')           // bold
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')               // bold alt
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')  // italic
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')        // italic alt
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')               // strikethrough
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>') // links
  // Auto-link bare URLs that aren't already inside an <a> tag
  result = result.replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, (m) => {
    const clean = m.replace(/[.,;:!?)&amp;]+$/, '')
    return `<a href="${clean}">${clean}</a>`
  })
  result = result.replace(/^- \[ \]/gm, '☐')                       // unchecked
  result = result.replace(/^- \[x\]/gm, '☑')                       // checked
  result = result.replace(/^---+$/gm, '')                           // horizontal rules
  result = result.replace(/^___+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Restore code blocks and inline code
  result = result.replace(/%%CB(\d+)%%/g, (_, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/%%IC(\d+)%%/g, (_, idx) => inlineCode[parseInt(idx)])

  return result.trim()
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    // Find a good split point (newline before limit)
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit)
    if (splitAt <= 0) splitAt = limit

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
