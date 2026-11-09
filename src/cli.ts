#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { EDITABLE, TEMPLATE, arr, exportMd, exportName, lines, missing, parseMd, projectLines, projectMd, repoName, str, ticketMd, toStatus } from './format'
import { mcpKey, webhookSecret } from './secret'

const HELP = `cradle - tickets for agents

  cradle ls [-p ABC] [-s todo,doing] [-a name] [-l label] [-q text] [--parent ID] [--all]
  cradle show ID [-n]                  -n adds notes
  cradle new "Title" [-p ABC] [-s status] [-a name] [-l bug,repo:x] [-b body | -f file|- | -e] [--parent ID] [--blocked-by ID,ID]
  cradle edit ID [-t title] [-s status] [-a name] [-l labels] [--pr url] [--parent ID] [--blocked-by ID,ID] [-b body | -f file|-]
  cradle edit ID -e                    edit in $EDITOR
  cradle mv ID [ID...] STATUS          statuses: backlog todo doing done cancelled
  cradle note ID "text"
  cradle start ID                      status=doing + git checkout branch
  cradle branch ID
  cradle import FILE|- [-p ABC] [-s status] [--split]   reads cradle and Backlog.md files
  cradle export ID [ID...] [-o DIR|FILE.md|-]          Backlog.md format, with notes
  cradle export -p ABC [--all] [-o DIR]                all open (or --all) tickets in a project
  cradle project                       list projects
  cradle project KEY|.                 goal, context, repos, ticket counts. . = this git repo's project
  cradle project new KEY "Name" [-r repo,repo] [-b context | -f file|-]
  cradle project edit KEY [-t name] [-r repo,repo] [-b context | -f file|-] [-e]
  cradle login [URL] [TOKEN]           asks for what is missing, checks it, saves it
  cradle mcp [add]                     print MCP URL + config. add: set up Claude Code
  cradle gh hook [owner/repo]          add webhook: PR opened -> doing, merged -> done

  --json   raw JSON output
  Ticket body: ## Goal, ## Done when (- [ ] testable items), ## Verify. new -e opens this template.
  Labels: bug, feature, improvement, chore, repo:<name>. -l replaces the list; -l '' clears.
  Project for new/import: -p, then CRADLE_PROJECT, then the project that owns this git repo (-r on project).`

const CONFIG = join(homedir(), '.config', 'cradle', 'config.json')

const parsed = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        project: { type: 'string', short: 'p' },
        status: { type: 'string', short: 's' },
        assignee: { type: 'string', short: 'a' },
        labels: { type: 'string', short: 'l' },
        repo: { type: 'string', short: 'r' },
        title: { type: 'string', short: 't' },
        body: { type: 'string', short: 'b' },
        file: { type: 'string', short: 'f' },
        out: { type: 'string', short: 'o' },
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

let cfg: { url: string; token: string } | undefined

function config() {
  if (cfg) return cfg
  const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {}
  const url = process.env.CRADLE_URL ?? file.url
  const token = process.env.CRADLE_TOKEN ?? file.token
  if (!url || !token) die('not configured. run: cradle login URL')
  return (cfg = { url: url.replace(/\/$/, ''), token })
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

const out = (data: unknown, text: () => string) => console.log(o.json ? JSON.stringify(data) : text())
const ID = /^[A-Za-z]{2,5}-\d+$/
const need = (v: string | undefined, usage: string) => v ?? die(`usage: ${usage}`)

// Repo name from the origin remote, else the repo folder. undefined outside git.
function currentRepo() {
  const url = run(['git', 'remote', 'get-url', 'origin'])
  if (url.ok) return repoName(url.out)
  const top = run(['git', 'rev-parse', '--show-toplevel'])
  return top.ok ? repoName(top.out) : undefined
}

const projectForRepo = (repo: string) => api('GET', `/repos/${encodeURIComponent(repo)}`)

// -p, then CRADLE_PROJECT, then the project that owns this git repo
async function defaultProject(): Promise<string> {
  if (o.project) return o.project
  if (process.env.CRADLE_PROJECT) return process.env.CRADLE_PROJECT
  const repo = currentRepo() ?? die('no project. Use -p ABC, or run in a git repo that a project owns')
  return (await projectForRepo(repo)).key
}

async function readInput(file: string) {
  return file === '-' ? await Bun.stdin.text() : readFileSync(file, 'utf8')
}

async function bodyArg() {
  if (o.body !== undefined) return o.body
  if (o.file) return await readInput(o.file)
}

// '' clears a field
const clear = (v?: string) => (v === '' ? null : v)

function run(cmd: string[], stdin?: string) {
  const r = Bun.spawnSync(cmd, { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

const cmds: Record<string, () => Promise<void>> = {
  async ls() {
    const qs = new URLSearchParams()
    const add = (k: string, v?: string) => v && qs.set(k, v)
    add('project', o.project)
    add('status', o.status)
    add('assignee', o.assignee)
    add('parent', o.parent)
    add('label', o.labels)
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
    const body = o.editor ? (editText('new.md', TEMPLATE) ?? die('no change, not created')).trim() : await bodyArg()
    const r = await api('POST', '/tickets', {
      project: await defaultProject(),
      title,
      status: o.status,
      assignee: o.assignee,
      parent: o.parent,
      blocked_by: arr(o['blocked-by']),
      labels: arr(o.labels),
      body,
    })
    const gaps = missing(body)
    if (gaps.length) console.error(`${r.ids[0]} missing ${gaps.map((h) => `## ${h}`).join(', ')}`)
    out(r, () => r.ids[0])
  },

  async edit() {
    const id = need(args[1], 'cradle edit ID [flags | -e]')
    if (o.editor) return editInEditor(id)
    const patch = {
      title: o.title,
      status: o.status,
      assignee: clear(o.assignee),
      pr: clear(o.pr),
      parent: clear(o.parent),
      blocked_by: o['blocked-by'] !== undefined ? arr(o['blocked-by']) : undefined,
      labels: o.labels !== undefined ? arr(o.labels) : undefined,
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
    const r = await api('POST', '/tickets', ids.map((id) => ({ id, status })))
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
    if (!run(['git', 'rev-parse', '--git-dir']).ok) die('not in a git repo')
    const t = await api('GET', `/tickets/${id}`)
    const exists = run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`]).ok
    const r = run(['git', 'checkout', ...(exists ? [] : ['-b']), t.branch])
    if (!r.ok) die(r.err)
    if (t.status !== 'doing') await api('PATCH', `/tickets/${t.id}`, { status: 'doing' })
    console.log(`${t.id} doing, on ${t.branch}`)
  },

  async import() {
    const file = need(args[1], 'cradle import FILE|- [-p ABC] [--split]')
    const { fm, title, body, notes } = parseMd(await readInput(file))
    const project = (await defaultProject()).toUpperCase()
    // Cradle keys, else Backlog.md keys. A file from another project or tracker keeps no id links.
    const foreign = !!fm.id && !str(fm.id)!.toUpperCase().startsWith(`${project}-`)
    const ids = (v?: string | string[]) => {
      const all = arr(v)
      const bad = all.filter((x) => foreign || !ID.test(x))
      if (bad.length) console.error(`skipped links: ${bad.join(', ')}`)
      return all.filter((x) => !bad.includes(x))
    }
    const base = {
      project,
      status: toStatus(o.status ?? str(fm.status)),
      assignee: arr(fm.assignee)[0]?.replace(/^@/, ''),
      parent: o.parent ?? ids(fm.parent ?? fm.parent_task_id)[0],
      blocked_by: ids(fm.blocked_by ?? fm.dependencies),
      labels: [...arr(fm.labels), ...arr(o.labels)],
      pr: str(fm.pr),
    }
    const t = title ?? (file === '-' ? die('no title. add a # heading') : basename(file).replace(/\.md$/i, ''))

    if (!o.split) {
      const r = await api('POST', '/tickets', { ...base, title: t, body, note: notes })
      return out(r, () => r.ids[0])
    }

    // --split: text before the first ## goes to the parent, each ## section is a sub-ticket
    const [intro, ...sections] = body.split(/^## /m)
    if (!sections.length) die('no ## sections to split')
    const {
      ids: [pid],
    } = await api('POST', '/tickets', { ...base, title: t, body: intro.trim(), note: notes })
    const kids = sections.map((s) => {
      const [head, ...rest] = s.split('\n')
      return {
        project: base.project,
        status: base.status,
        labels: base.labels,
        parent: pid,
        title: head.trim(),
        body: rest.join('\n').trim(),
      }
    })
    const r = await api('POST', '/tickets', kids)
    out({ ids: [pid, ...r.ids] }, () => `${pid}\n${r.ids.map((i: string) => `  ${i}`).join('\n')}`)
  },

  async export() {
    let ids = args.slice(1)
    if (!ids.length) {
      if (!o.project) die('usage: cradle export ID [ID...] [-o DIR|FILE.md|-] or cradle export -p ABC [--all]')
      const rows = await api('GET', `/tickets?project=${o.project}&limit=500${o.all ? '&all=1' : ''}`)
      ids = rows.map((t: { id: string }) => t.id)
      if (!ids.length) die('no tickets')
    }
    const tickets = await Promise.all(ids.map((id) => api('GET', `/tickets/${id}?notes=1`)))
    const dest = o.out ?? '.'
    if (dest === '-') return console.log(tickets.map(exportMd).join('\n'))
    const files: [string, string][] = /\.md$/i.test(dest)
      ? tickets.length > 1
        ? die('-o FILE.md takes one ticket. Use a dir.')
        : [[dest, exportMd(tickets[0])]]
      : tickets.map((t) => [join(dest, exportName(t)), exportMd(t)])
    mkdirSync(dirname(files[0][0]), { recursive: true })
    for (const [path, md] of files) writeFileSync(path, md)
    out(files.map(([p]) => p), () => files.map(([p]) => p).join('\n'))
  },

  async project() {
    const [, sub, key, name] = args
    const repos = o.repo !== undefined ? arr(o.repo) : undefined
    if (sub === 'new') {
      const usage = 'cradle project new KEY "Name" [-r repo,repo] [-b context | -f file|-]'
      const body = { key: need(key, usage), name: need(name, usage), repos, description: await bodyArg() }
      const r = await api('POST', '/projects', body)
      return out(r, () => r.key)
    }
    if (sub === 'edit') {
      const k = need(key, 'cradle project edit KEY [-t name] [-r repo,repo] [-b context | -f file|-] [-e]')
      if (o.editor) return editProject(k)
      const patch = { name: o.title, repos, description: await bodyArg() }
      if (Object.values(patch).every((v) => v === undefined)) die('nothing to change')
      const r = await api('PATCH', `/projects/${k}`, patch)
      return out(r, () => 'ok')
    }
    if (sub) {
      const repo = sub === '.' ? (currentRepo() ?? die('not in a git repo')) : undefined
      const p = await (repo ? projectForRepo(repo) : api('GET', `/projects/${sub}`))
      return out(p, () => projectMd(p).trimEnd())
    }
    const rows = await api('GET', '/projects')
    out(rows, () => projectLines(rows))
  },

  async mcp() {
    const { url, token } = config()
    const mcpUrl = `${url}/mcp/${await mcpKey(token)}`
    if (args[1] === 'add') {
      run(['claude', 'mcp', 'remove', 'cradle', '-s', 'user'])
      const r = run(['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'cradle', mcpUrl])
      if (!r.ok) die(r.err || 'claude mcp add failed. Is Claude Code installed?')
      return console.log('added cradle to Claude Code (user scope). Restart sessions to load it.')
    }
    console.log(`URL: ${mcpUrl}\n\nConfig for other agents:\n${JSON.stringify({ mcpServers: { cradle: { type: 'http', url: mcpUrl } } }, null, 2)}\n\nClaude Code: cradle mcp add`)
  },

  async gh() {
    if (args[1] !== 'hook') die('usage: cradle gh hook [owner/repo]')
    const gh = (a: string[], stdin?: string) => {
      const r = run(['gh', ...a], stdin)
      return r.ok ? r.out : die(r.err || r.out || 'gh failed')
    }
    const repo = args[2] ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
    const { url, token } = config()
    const hookUrl = `${url}/gh`
    const body = JSON.stringify({
      config: { url: hookUrl, content_type: 'json', secret: await webhookSecret(token) },
      events: ['pull_request'],
      active: true,
    })
    // Update if a cradle hook exists (refreshes the secret), else create
    const existing = gh(['api', `repos/${repo}/hooks`, '--jq', `.[] | select(.config.url == "${hookUrl}") | .id`])
    const path = existing ? `repos/${repo}/hooks/${existing.split('\n')[0]}` : `repos/${repo}/hooks`
    gh(['api', '-X', existing ? 'PATCH' : 'POST', path, '--input', '-'], body)
    console.log(`${existing ? 'updated' : 'added'} webhook on ${repo}`)
  },

  async login() {
    const url = (args[1] ?? ask('URL (https://cradle.<you>.workers.dev):')).trim().replace(/\/$/, '')
    const token = (args[2] ?? ask('Token:', true)).trim()
    if (!url || !token) die('usage: cradle login URL [TOKEN]')
    const res = await fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${token}` } }).catch((e: Error) =>
      die(`cannot reach ${url}: ${e.message}`),
    )
    if (res.status === 401) die('wrong token')
    if (!res.ok) die(`${url} is not a cradle server (HTTP ${res.status})`)
    mkdirSync(dirname(CONFIG), { recursive: true })
    writeFileSync(CONFIG, JSON.stringify({ url, token }), { mode: 0o600 })
    console.log(`saved ${CONFIG}\nNext, to connect Claude Code: cradle mcp add`)
  },
}

cmds.config = cmds.login

// Read one line from the terminal. hidden: no echo.
function ask(question: string, hidden = false) {
  const stty = (mode: string) => hidden && Bun.spawnSync(['stty', mode], { stdin: 'inherit' })
  stty('-echo')
  try {
    return prompt(question) ?? ''
  } finally {
    if (hidden) {
      stty('echo')
      console.log()
    }
  }
}

// Open text in $EDITOR. Returns the new text, or undefined if unchanged.
function editText(name: string, text: string) {
  const path = join(tmpdir(), name)
  writeFileSync(path, text)
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const r = Bun.spawnSync(['sh', '-c', `${editor} "$1"`, 'sh', path], { stdio: ['inherit', 'inherit', 'inherit'] })
  if (r.exitCode !== 0) die('editor failed')
  const after = readFileSync(path, 'utf8')
  return after === text ? undefined : after
}

// `# Name` + markdown context
async function editProject(key: string) {
  const p = await api('GET', `/projects/${key}`)
  const after = editText(`${p.key}.md`, `# ${p.name}\n\n${p.description ?? ''}\n`)
  if (after === undefined) return console.log('no change')
  const { title, body } = parseMd(after)
  const patch: Record<string, string> = {}
  if (title && title !== p.name) patch.name = title
  if (body !== (p.description ?? '').trim()) patch.description = body
  if (!Object.keys(patch).length) return console.log('no change')
  await api('PATCH', `/projects/${p.key}`, patch)
  console.log(`saved ${Object.keys(patch).join(', ')}`)
}

async function editInEditor(id: string) {
  const t = await api('GET', `/tickets/${id}`)
  const after = editText(`${t.id}.md`, ticketMd({ ...t, children: [] }))
  if (after === undefined) return console.log('no change')

  const { fm, title, body } = parseMd(after)
  const patch: Record<string, unknown> = {}
  if (title && title !== t.title) patch.title = title
  if (body !== (t.body ?? '').trim()) patch.body = body
  for (const k of EDITABLE) {
    const now = str(fm[k]) ?? ''
    const was = Array.isArray(t[k]) ? t[k].join(', ') : (t[k] ?? '')
    if (now !== was) patch[k] = k === 'blocked_by' || k === 'labels' ? arr(now) : now || null
  }
  if (!Object.keys(patch).length) return console.log('no change')
  await api('PATCH', `/tickets/${t.id}`, patch)
  console.log(`saved ${Object.keys(patch).join(', ')}`)
}

const cmd = args[0]
if (!cmd || o.help) console.log(HELP)
else if (!cmds[cmd]) die(`unknown command: ${cmd}\n\n${HELP}`)
else await cmds[cmd]()
