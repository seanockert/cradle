// Values derived from TOKEN, so there are no extra secrets. Changing TOKEN changes all of them.
export async function derive(token: string, purpose: 'gh' | 'web' | 'mcp') {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cradle-${purpose}:${token}`))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// GitHub webhook secret
export const webhookSecret = (token: string) => derive(token, 'gh')

// MCP URL key: /mcp/<key>. Only opens MCP, not REST.
export const mcpKey = (token: string) => derive(token, 'mcp')
