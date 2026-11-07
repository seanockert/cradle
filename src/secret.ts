// Values derived from TOKEN, so there are no extra secrets. Changing TOKEN changes all of them.
import { timingSafeEqual } from 'hono/utils/buffer'

export const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export const derive = async (token: string, purpose: 'gh' | 'web' | 'mcp') =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cradle-${purpose}:${token}`)))

export const webhookSecret = (token: string) => derive(token, 'gh')

// MCP URL key: /mcp/<key>. Opens MCP only, not REST.
export const mcpKey = (token: string) => derive(token, 'mcp')

// Constant-time compare. Empty never matches, so a missing TOKEN denies all.
export const same = async (a?: string | null, b?: string | null) => !!a && !!b && (await timingSafeEqual(a, b))
