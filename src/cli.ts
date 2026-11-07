#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { EDITABLE, lines, parseMd, projectLines, ticketMd } from './format'
import { webhookSecret } from './secret'

const HELP = `cradle - tickets for agents

  cradle ls [-p ABC] [-s todo,doing] [-a name] [-q text] [--parent ID] [--all]
  cradle show ID [-n]                  -n adds notes
  cradle new "Title" [-p ABC] [-s status] [-a name] [-b body | -f file|-] [--parent ID] [--blocked-by ID,ID]
  cradle edit ID [-t title] [-s status] [-a name] [--pr url] [--parent ID] [--blocked-by ID,ID] [-b body | -f file|-]
  cradle edit ID -e                    edit in $EDITOR
  cradle mv ID [ID...] STATUS          statuses: backlog todo doing done cancelled
  cradle note ID "text"
  cradle start ID                      status=doing + git checkout branch
  cradle branch ID
  cradle import FILE|- [-p ABC] [-s status] [--split]
  cradle project [new KEY "Name" [description]]
  cradle config URL TOKEN
  cradle gh hook [owner/repo]          add webhook: PR opened -> doing, merged -> done

  --json   raw JSON output
  Project default: CRADLE_PROJECT env, or a .cradle file (with a key, e.g. ABC) in this or a parent dir.`

const CONFIG = join(homedir(), '.config', 'cradle', 'config.json')

const parsed = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        project: { type: 'string', short: 'p' },
        status: { type: 'string', short: 's' },
        assignee: { type: 'string', short: 'a' },
        title: { type: 'string', short: 't' },
        body: { type: 'string', short: 'b' },
        file: { type: 'string', short: 'f' },
        q: { type: 'string', short: 'q' },
        parent: { type: 'string' },
        'blocked-by': { type: 'string' },
        pr: { type: 'string' },
        all: { type: 'boolean' },
        notes: { type: 'boolean', short: 'n' },
        editor: { type: 'boolean', short: 'e' },
        split: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    console.error(`${(e as Error).message.split('.')[0]}. see cradle --help`)
    process.exit(1)
  }
})()
const { values: o, positionals: args } = parsed

const die = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

// --- api ---

function config(): { url: string; token: string } {
  const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {}
  const url = process.env.CRADLE_URL ?? file.url
  const token = process.env.CRADLE_TOKEN ?? file.token
  if (!url || !token) die('not configured. run: cradle config URL TOKEN')
  return { url: url.replace(/\/$/, ''), token }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const { url, token } = config()
  const res = await fetch(`${url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) die(`error: ${data.error ?? res.status}`)
  return data
}

// --- helpers ---

const out = (data: unknown, text: () => string) => console.log(o.json ? JSON.stringify(data) : text())
const list = (s?: string) =>
  s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean)
const need = (v: string | undefined, usage: string) => v ?? die(`usage: ${usage}`)

function defaultProject() {
  if (o.project) return o.project
  if (process.env.CRADLE_PROJECT) return process.env.CRADLE_PROJECT
  for (let d = process.cwd(); ; d = dirname(d)) {
    const f = join(d, '.cradle')
    if (existsSync(f)) return readFileSync(f, 'utf8').trim()
    if (d === dirname(d)) return die('no project. use -p ABC or add a .cradle file')
  }
}

async function readInput(file: string) {
  return file === '-' ? await Bun.stdin.text() : readFileSync(file, 'utf8')
}

async function bodyArg() {
  if (o.body !== undefined) return o.body
  if (o.file) return await readInput(o.file)
}

const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { stdout: 'pipe', stderr: 'pipe' })

// --- commands ---

const cmds: Record<string, () => Promise<void>> = {
  async ls() {
    const qs = new URLSearchParams()
    const add = (k: string, v?: string) => v && qs.set(k, v)
    add('project', o.project)
    add('status', o.status)
    add('assignee', o.assignee)
    add('parent', o.parent)
    add('q', o.q)
    if (o.all) qs.set('all', '1')
    const rows = await api('GET', `/tickets?${qs}`)
    out(rows, () => lines(rows))
  },

  async show() {
    const id = need(args[1], 'cradle show ID')
    const t = await api('GET', `/tickets/${id}${o.notes ? '?notes=1' : ''}`)
    out(t, () => ticketMd(t).trimEnd())
  },

  async new() {
    const title = need(args[1], 'cradle new "Title" [-p ABC]')
    const r = await api('POST', '/tickets', {
      project: defaultProject(),
      title,
      status: o.status,
      assignee: o.assignee,
      parent: o.parent,
      blocked_by: list(o['blocked-by']),
      body: await bodyArg(),
    })
    out(r, () => r.ids[0])
  },

  async edit() {
    const id = need(args[1], 'cradle edit ID [flags | -e]')
    if (o.editor) return editInEditor(id)
    const patch = {
      title: o.title,
      status: o.status,
      assignee: o.assignee === '' ? null : o.assignee,
      pr: o.pr,
      parent: o.parent === '' ? null : o.parent,
      blocked_by: o['blocked-by'] !== undefined ? list(o['blocked-by']) : undefined,
      body: await bodyArg(),
    }
    if (Object.values(patch).every((v) => v === undefined)) die('nothing to change')
    const r = await api('PATCH', `/tickets/${id}`, patch)
    out(r, () => 'ok')
  },

  async mv() {
    const status = args.at(-1)
    const ids = args.slice(1, -1)
    if (!ids.length || !status) die('usage: cradle mv ID [ID...] STATUS')
    const r = await api(
      'POST',
      '/tickets',
      ids.map((id) => ({ id, status })),
    )
    out(r, () => 'ok')
  },

  async note() {
    const id = need(args[1], 'cradle note ID "text"')
    const text = need(args.slice(2).join(' ') || undefined, 'cradle note ID "text"')
    const r = await api('PATCH', `/tickets/${id}`, { note: text })
    out(r, () => 'ok')
  },

  async branch() {
    const t = await api('GET', `/tickets/${need(args[1], 'cradle branch ID')}`)
    out({ branch: t.branch }, () => t.branch)
  },

  async start() {
    const id = need(args[1], 'cradle start ID')
    if (git('rev-parse', '--git-dir').exitCode !== 0) die('not in a git repo')
    const t = await api('GET', `/tickets/${id}`)
    const exists = git('rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`).exitCode === 0
    const r = git('checkout', ...(exists ? [] : ['-b']), t.branch)
    if (r.exitCode !== 0) die(r.stderr.toString().trim())
    if (t.status !== 'doing') await api('PATCH', `/tickets/${t.id}`, { status: 'doing' })
    console.log(`${t.id} doing, on ${t.branch}`)
  },

  async import() {
    const file = need(args[1], 'cradle import FILE|- [-p ABC] [--split]')
    const { fm, title, body } = parseMd(await readInput(file))
    const base = {
      project: defaultProject(),
      status: o.status ?? fm.status,
      assignee: fm.assignee,
      parent: o.parent ?? fm.parent,
      blocked_by: list(fm.blocked_by),
    }
    const t = title ?? (file === '-' ? die('no title. add a # heading') : basename(file).replace(/\.md$/i, ''))

    if (!o.split) {
      const r = await api('POST', '/tickets', { ...base, title: t, body })
      return out(r, () => r.ids[0])
    }

    // --split: text before the first ## goes to the parent, each ## section is a sub-ticket
    const [intro, ...sections] = body.split(/^## /m)
    if (!sections.length) die('no ## sections to split')
    const {
      ids: [pid],
    } = await api('POST', '/tickets', { ...base, title: t, body: intro.trim() })
    const kids = sections.map((s) => {
      const [head, ...rest] = s.split('\n')
      return {
        project: base.project,
        status: base.status,
        parent: pid,
        title: head.trim(),
        body: rest.join('\n').trim(),
      }
    })
    const r = await api('POST', '/tickets', kids)
    out({ ids: [pid, ...r.ids] }, () => `${pid}\n${r.ids.map((i: string) => `  ${i}`).join('\n')}`)
  },

  async project() {
    if (args[1] === 'new') {
      const key = need(args[2], 'cradle project new KEY "Name" [description]')
      const name = need(args[3], 'cradle project new KEY "Name" [description]')
      const r = await api('POST', '/projects', { key, name, description: args[4] })
      return out(r, () => r.key)
    }
    const rows = await api('GET', '/projects')
    out(rows, () => projectLines(rows))
  },

  async gh() {
    if (args[1] !== 'hook') die('usage: cradle gh hook [owner/repo]')
    const gh = (...a: string[]) => {
      const r = Bun.spawnSync(['gh', ...a], { stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0) die(r.stderr.toString().trim() || 'gh failed')
      return r.stdout.toString().trim()
    }
    const repo = args[2] ?? gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner')
    const { url, token } = config()
    const hookUrl = `${url}/gh`
    const body = JSON.stringify({
      config: { url: hookUrl, content_type: 'json', secret: await webhookSecret(token) },
      events: ['pull_request'],
      active: true,
    })
    // Update if a cradle hook exists (refreshes the secret), else create
    const existing = gh('api', `repos/${repo}/hooks`, '--jq', `.[] | select(.config.url == "${hookUrl}") | .id`)
    const path = existing ? `repos/${repo}/hooks/${existing.split('\n')[0]}` : `repos/${repo}/hooks`
    const r = Bun.spawnSync(['gh', 'api', '-X', existing ? 'PATCH' : 'POST', path, '--input', '-'], {
      stdin: new TextEncoder().encode(body),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) die(r.stderr.toString().trim() || r.stdout.toString().trim())
    console.log(`${existing ? 'updated' : 'added'} webhook on ${repo}`)
  },

  async config() {
    const [, url, token] = args
    if (!url || !token) die('usage: cradle config URL TOKEN')
    mkdirSync(dirname(CONFIG), { recursive: true })
    writeFileSync(CONFIG, JSON.stringify({ url, token }), { mode: 0o600 })
    console.log(`saved ${CONFIG}`)
  },
}

async function editInEditor(id: string) {
  const t = await api('GET', `/tickets/${id}`)
  const before = ticketMd({ ...t, children: [] })
  const path = join(tmpdir(), `${t.id}.md`)
  writeFileSync(path, before)
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const r = Bun.spawnSync(['sh', '-c', `${editor} "$1"`, 'sh', path], { stdio: ['inherit', 'inherit', 'inherit'] })
  if (r.exitCode !== 0) die('editor failed')
  const after = readFileSync(path, 'utf8')
  if (after === before) return console.log('no change')

  const { fm, title, body } = parseMd(after)
  const patch: Record<string, unknown> = {}
  if (title && title !== t.title) patch.title = title
  if (body !== (t.body ?? '').trim()) patch.body = body
  for (const k of EDITABLE) {
    const now = fm[k] ?? ''
    const was = Array.isArray(t[k]) ? t[k].join(', ') : (t[k] ?? '')
    if (now !== was) patch[k] = k === 'blocked_by' ? (list(now) ?? []) : now || null
  }
  if (!Object.keys(patch).length) return console.log('no change')
  await api('PATCH', `/tickets/${t.id}`, patch)
  console.log(`saved ${Object.keys(patch).join(', ')}`)
}

const cmd = args[0]
if (!cmd || o.help) console.log(HELP)
else if (!cmds[cmd]) die(`unknown command: ${cmd}\n\n${HELP}`)
else await cmds[cmd]()
