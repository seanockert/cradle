// Text output for CLI, MCP and export. Compact for agents, standard for files.

type Row = Record<string, any>

// ABC-3 [todo] Stripe webhook #bug @sean parent:ABC-2 blocked_by:ABC-1
export function line(t: Row) {
  return [
    t.id,
    `[${t.status}]`,
    t.title,
    t.labels?.map((l: string) => `#${l}`).join(' '),
    t.assignee && `@${t.assignee}`,
    t.parent && `parent:${t.parent}`,
    t.blocked_by?.length && `blocked_by:${t.blocked_by.join(',')}`,
  ]
    .filter(Boolean)
    .join(' ')
}

export const lines = (rows: Row[]) => (rows.length ? rows.map(line).join('\n') : 'no tickets')

// First non-heading line of markdown, max 100 chars
export function summary(md?: string) {
  const all = md?.split('\n').map((x) => x.trim()).filter(Boolean) ?? []
  const l = (all.find((x) => !x.startsWith('#')) ?? all[0] ?? '').replace(/^[#\-*>\s]+/, '')
  return l.length > 100 ? `${l.slice(0, 100).replace(/\s+\S*$/, '').slice(0, 99)}…` : l
}

// Repo name from "cradle", "owner/cradle" or a git URL
export const repoName = (s: string) => s.trim().toLowerCase().replace(/\.git$/, '').split(/[/:]/).pop() ?? ''

const repoTag = (p: Row) => (p.repos?.length ? ` [${p.repos.join(', ')}]` : '')

// ABC Shop [shop, shop-api] (3 open) - Sell prints online.
export const projectLines = (rows: Row[]) =>
  rows.length
    ? rows
        .map((p) => `${p.key} ${p.name}${repoTag(p)} (${p.open} open)${p.description ? ` - ${summary(p.description)}` : ''}`)
        .join('\n')
    : 'no projects'

export const STATUSES = ['backlog', 'todo', 'doing', 'done', 'cancelled'] as const

// One project: name, ticket counts, full context
export function projectMd(p: Row) {
  const counts = STATUSES.filter((s) => p.tickets?.[s]).map((s) => `${p.tickets[s]} ${s}`)
  const repos = p.repos?.length ? `repos: ${p.repos.join(', ')}\n` : ''
  return `# ${p.key} ${p.name}\n${repos}tickets: ${counts.join(', ') || 'none'}\n\n${p.description?.trim() || 'No context yet.'}\n`
}

// Ticket body standard: another agent can do and verify the work with no other context
const SECTIONS = ['Goal', 'Done when', 'Verify']
export const TEMPLATE = `## Goal

Why this matters. Link it to the project goal.

## Done when

- [ ] A result you can test

## Verify

- A command or step that proves each item
`
export const missing = (body = '') => SECTIONS.filter((h) => !new RegExp(`^## ${h}\\b`, 'im').test(body))

const minute = (ts: string) => ts.slice(0, 16)

const notesMd = (notes: Row[]) => `\n## Notes\n\n${notes.map((n) => `- ${minute(n.ts)} ${n.text.replace(/\n/g, '\n  ')}`).join('\n')}\n`

// Frontmatter keys use the MCP `save` names. `cradle edit -e` reads the same keys back.
export const EDITABLE = ['status', 'labels', 'assignee', 'branch', 'parent', 'blocked_by', 'pr'] as const

// Compact view for agents (MCP get, cradle show)
export function ticketMd(t: Row) {
  const fm = [`id: ${t.id}`]
  for (const k of EDITABLE) {
    const v = Array.isArray(t[k]) ? t[k].join(', ') : t[k]
    if (v) fm.push(`${k}: ${v}`)
  }
  fm.push(`updated: ${minute(t.updated)}`)
  let md = `---\n${fm.join('\n')}\n---\n# ${t.title}\n`
  if (t.body) md += `\n${t.body.trim()}\n`
  if (t.children?.length) md += `\n## Sub-tickets\n${lines(t.children)}\n`
  if (t.notes?.length) md += notesMd(t.notes)
  return md
}

const TO_BACKLOG: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  doing: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

// Cradle status from cradle or Backlog.md names. Unknown values pass through, so the server rejects them.
export function toStatus(s?: string) {
  if (!s) return undefined
  const k = s.toLowerCase().replace(/[\s_-]/g, '')
  return ({ todo: 'todo', inprogress: 'doing', canceled: 'cancelled' } as Record<string, string>)[k] ?? k
}

// Plain YAML scalar if safe, else a JSON string (valid YAML)
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i
const yaml = (v: string) => (/^[A-Za-z_][\w ./@()+-]*$/.test(v) && !RESERVED.test(v) && v.trim() === v ? v : JSON.stringify(v))

// Backlog.md task format: YAML frontmatter with title, then body and notes
export function exportMd(t: Row) {
  const fm: string[] = []
  const put = (k: string, v: unknown) => {
    if (Array.isArray(v)) v.length && fm.push(`${k}:`, ...v.map((x) => `  - ${yaml(x)}`))
    else if (v) fm.push(`${k}: ${yaml(String(v))}`)
  }
  put('id', t.id)
  put('title', t.title)
  put('status', TO_BACKLOG[t.status] ?? t.status)
  put('assignee', t.assignee ? [t.assignee] : [])
  put('labels', t.labels ?? [])
  put('created_date', t.created && minute(t.created))
  put('updated_date', t.updated && minute(t.updated))
  put('dependencies', t.blocked_by ?? [])
  put('parent_task_id', t.parent)
  put('branch', t.branch)
  put('pr', t.pr)
  let md = `---\n${fm.join('\n')}\n---\n`
  if (t.body) md += `\n${t.body.trim()}\n`
  if (t.notes?.length) md += notesMd(t.notes)
  return md
}

// Prompt to paste into an agent chat. Ticket as XML-style tags, like Linear "copy as prompt".
export function promptMd(t: Row, p?: Row) {
  const project = p && `<project key="${p.key}" name="${p.name}">${p.description ? summary(p.description) : ''}</project>`
  const ticket = [
    `<ticket id="${t.id}">`,
    `<title>${t.title}</title>`,
    `<status>${t.status}</status>`,
    ...(t.labels ?? []).map((l: string) => `<label>${l}</label>`),
    project,
    t.body && `<description>\n${t.body.trim()}\n</description>`,
    t.parent && `<parent id="${t.parent}"/>`,
    ...(t.blocked_by ?? []).map((b: string) => `<blocked-by id="${b}"/>`),
    t.children?.length &&
      `<sub-tickets>\n${t.children.map((c: Row) => `<ticket-ref id="${c.id}" status="${c.status}">${c.title}</ticket-ref>`).join('\n')}\n</sub-tickets>`,
    '</ticket>',
  ]
  return [`Work on cradle ticket ${t.id}:`, t.branch && `Branch: ${t.branch}`, ticket.filter(Boolean).join('\n')]
    .filter(Boolean)
    .join('\n\n')
}

// Backlog.md style: "abc-1 - Fix-auth-redirect.md"
export const exportName = (t: Row) =>
  `${t.id.toLowerCase()} - ${t.title.replace(/[\\/:*?"<>|#\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}.md`

const unquote = (v: string) => {
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v) as string
    } catch {}
  }
  return /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v
}

// Frontmatter subset: `key: value`, `key: [a, b]`, `key:` + `  - item` lines
function parseFm(src: string) {
  const fm: Record<string, string | string[]> = {}
  let list: string[] | undefined
  for (const l of src.split(/\r?\n/)) {
    const item = l.match(/^\s+-\s+(.*)$/)
    if (item && list) {
      list.push(unquote(item[1].trim()))
      continue
    }
    const i = l.indexOf(':')
    if (i <= 0 || /^\s/.test(l)) continue
    const k = l.slice(0, i).trim()
    const v = l.slice(i + 1).trim()
    list = undefined
    if (!v) fm[k] = list = []
    else if (/^\[.*\]$/.test(v)) fm[k] = v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean)
    else fm[k] = unquote(v)
  }
  return fm
}

// List as string; string as list
export const str = (v?: string | string[]) => (Array.isArray(v) ? v.join(', ') : v)
export const arr = (v?: string | string[]) =>
  (Array.isArray(v) ? v : (v?.split(',') ?? [])).map((x) => x.trim()).filter(Boolean)

// `---` frontmatter + optional `# Title` + body. Reads ticketMd, exportMd and Backlog.md files.
export function parseMd(src: string) {
  let rest = src.replace(/^﻿/, '')
  const m = rest.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fm = m ? parseFm(m[1]) : {}
  if (m) rest = rest.slice(m[0].length)
  let title = str(fm.title)
  const h1 = !title && rest.match(/^\s*# (.+)\r?\n?/)
  if (h1) {
    title = h1[1].trim()
    rest = rest.slice(h1[0].length)
  }
  // notesMd writes `## Notes` as the last section. Read it back as notes, not body.
  const n = rest.match(/(?:^|\n)## Notes[ \t]*\r?\n((?:(?!\n## )[\s\S])*)$/)
  const notes = n?.[1].trim() || undefined
  if (n) rest = rest.slice(0, n.index)
  return { fm, title, body: rest.trim(), notes }
}
