// Compact text output. CLI and MCP both use this.

type Row = Record<string, any>

// ABC-3 [todo] Stripe webhook @sean parent:ABC-2 blocked_by:ABC-1
export function line(t: Row) {
  return [
    t.id,
    `[${t.status}]`,
    t.title,
    t.assignee && `@${t.assignee}`,
    t.parent && `parent:${t.parent}`,
    t.blocked_by?.length && `blocked_by:${t.blocked_by.join(',')}`,
  ]
    .filter(Boolean)
    .join(' ')
}

export const lines = (rows: Row[]) => (rows.length ? rows.map(line).join('\n') : 'no tickets')

export const projectLines = (rows: Row[]) =>
  rows.length
    ? rows.map((p) => `${p.key} ${p.name} (${p.open} open)${p.description ? ` - ${p.description}` : ''}`).join('\n')
    : 'no projects'

// Fields shown in frontmatter. `cradle edit -e` reads the same keys back.
export const EDITABLE = ['status', 'assignee', 'branch', 'parent', 'blocked_by', 'pr'] as const

export function ticketMd(t: Row) {
  const fm = [`id: ${t.id}`]
  for (const k of EDITABLE) {
    const v = Array.isArray(t[k]) ? t[k].join(', ') : t[k]
    if (v) fm.push(`${k}: ${v}`)
  }
  fm.push(`updated: ${t.updated}`)
  let md = `---\n${fm.join('\n')}\n---\n# ${t.title}\n`
  if (t.body) md += `\n${t.body.trim()}\n`
  if (t.children?.length) md += `\n## Sub-tickets\n${lines(t.children)}\n`
  if (t.notes?.length) md += `\n## Notes\n${t.notes.map((n: Row) => `${n.ts.slice(0, 16)} ${n.text}`).join('\n')}\n`
  return md
}

// Parse `---` frontmatter (key: value lines) + `# Title` + body
export function parseMd(src: string) {
  const fm: Record<string, string> = {}
  let rest = src.replace(/^﻿/, '')
  const m = rest.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    for (const l of m[1].split(/\r?\n/)) {
      const i = l.indexOf(':')
      if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
    rest = rest.slice(m[0].length)
  }
  let title = fm.title
  const h1 = rest.match(/^\s*# (.+)\r?\n?/)
  if (h1) {
    title ??= h1[1].trim()
    rest = rest.slice(h1[0].length)
  }
  return { fm, title, body: rest.trim() }
}
