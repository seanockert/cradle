// GitHub webhook: link PRs to tickets by branch name. Opened -> doing, merged -> done.
import { timingSafeEqual } from 'hono/utils/buffer'
import * as core from './core'
import { webhookSecret } from './secret'

// Matches abc-123-slug, and also user/abc-123-slug (Linear style)
const BRANCH = /(?:^|\/)([a-z]{2,5})-(\d+)(?:-|$)/i
const TITLE = /\b([a-z]{2,5})-(\d+)\b/i

export function ticketId(branch: string, title = '') {
  const m = branch.match(BRANCH) ?? title.match(TITLE)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}

async function validSignature(body: string, header: string | null, token: string) {
  if (!header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(await webhookSecret(token)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(hex, header.slice(7))
}

// Returns [status, text]. The text shows in GitHub's delivery log.
export async function handleGithub(req: Request, env: Env): Promise<[number, string]> {
  const body = await req.text()
  if (!env.TOKEN || !(await validSignature(body, req.headers.get('x-hub-signature-256'), env.TOKEN)))
    return [401, 'bad signature']

  const event = req.headers.get('x-github-event')
  if (event === 'ping') return [200, 'pong']
  if (event !== 'pull_request') return [200, `ignored ${event}`]

  const { action, pull_request: pr } = JSON.parse(body)
  if (!['opened', 'reopened', 'closed'].includes(action)) return [200, `ignored ${action}`]
  if (action === 'closed' && !pr.merged) return [200, 'closed without merge, ignored']

  const id = ticketId(pr.head.ref, pr.title)
  if (!id) return [200, 'no ticket id in branch or title']
  return [200, await core.linkPr(env.DB, id, pr.html_url, !!pr.merged)]
}
