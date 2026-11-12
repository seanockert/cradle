// Ticket operations. REST, MCP and webhook all call these.
import { z } from 'zod'
import { STATUSES, repoName } from './format'

export { STATUSES }
const CLOSED = `('done', 'cancelled')`

class HttpError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

// Map any error to a status + short message an agent can act on
export function errorInfo(err: unknown): { status: 400 | 404 | 409 | 500; error: string } {
  if (err instanceof z.ZodError) return { status: 400, error: z.prettifyError(err) }
  if (err instanceof HttpError) return { status: err.status, error: err.message }
  if (err instanceof SyntaxError) return { status: 400, error: 'invalid JSON' }
  const msg = (err as Error)?.message ?? ''
  if (msg.includes('FOREIGN KEY')) return { status: 400, error: 'unknown project, parent or blocked_by ticket' }
  if (msg.includes('UNIQUE')) return { status: 409, error: 'already exists' }
  console.error(err)
  return { status: 500, error: 'internal error' }
}

const Status = z.enum(STATUSES)
const Key = z
  .string()
  .regex(/^[A-Za-z]{2,5}$/, 'project key must be 2-5 letters')
  .transform((s) => s.toUpperCase())
const Id = z
  .string()
  .regex(/^[A-Za-z]{2,5}-\d+$/, 'ticket id must look like ABC-123')
  .transform((s) => s.toUpperCase())

// e.g. bug, feature, repo:cradle
const Label = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][\w.:/-]{0,59}$/, 'label: a-z 0-9 . _ : / -, max 60 chars')
const Labels = z.array(Label).max(10)

// Git repo name. Takes "cradle", "owner/cradle" or a git URL.
const Repo = z
  .string()
  .transform(repoName)
  .pipe(z.string().regex(/^[a-z0-9._-]{1,100}$/, 'repo: git repo name, e.g. cradle'))

// Exact-text replacements, like str_replace
const Edits = z.array(z.object({ old: z.string().min(1), new: z.string() }))

// description: markdown goal and context
const ProjectInput = z.object({
  key: Key,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  edits: Edits.optional(),
  repos: z.array(Repo).max(10).optional(),
})

const ListInput = z.object({
  project: Key.optional(),
  status: z.array(Status).optional(),
  assignee: z.string().optional(),
  parent: Id.optional(),
  label: Label.optional(),
  q: z.string().optional(),
  all: z.boolean().optional(), // include done + cancelled
  limit: z.number().int().min(1).max(500).default(100),
})

const CreateInput = z.object({
  project: Key,
  title: z.string().min(1),
  status: Status.default('backlog'),
  assignee: z.string().nullish(),
  parent: Id.nullish(),
  pr: z.string().nullish(),
  branch: z.string().min(1).nullish(),
  body: z.string().default(''),
  blocked_by: z.array(Id).default([]),
  labels: Labels.default([]),
  note: z.string().min(1).optional(),
})

// undefined = no change, null = clear
const UpdateInput = z.object({
  id: Id,
  title: z.string().min(1).optional(),
  status: Status.optional(),
  assignee: z.string().nullish(),
  parent: Id.nullish(),
  pr: z.string().nullish(),
  branch: z.string().min(1).optional(),
  body: z.string().optional(),
  edits: Edits.optional(),
  blocked_by: z.array(Id).optional(),
  labels: Labels.optional(),
  note: z.string().min(1).optional(),
})

export type ListOpts = z.input<typeof ListInput>

export async function listProjects(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT key, name, repos, description,
        (SELECT count(*) FROM tickets t WHERE t.project = p.key AND t.status NOT IN ${CLOSED}) AS open
      FROM projects p ORDER BY key`,
    )
    .all()
  return results.map((r) => compact({ ...r, repos: split(r.repos) }))
}

// Full context + ticket counts by status
export async function getProject(db: D1Database, rawKey: string) {
  const key = Key.parse(rawKey)
  const [p, counts] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT key, name, repos, description FROM projects WHERE key = ?').bind(key),
    db.prepare('SELECT status, count(*) AS n FROM tickets WHERE project = ? GROUP BY status').bind(key),
  ])
  const row = p.results[0] as { key: string; name: string; repos: string; description: string | null } | undefined
  if (!row) throw new HttpError(404, `project ${key} not found`)
  const tickets = Object.fromEntries(counts.results.map((r) => [r.status, r.n]))
  return compact({ ...row, repos: split(row.repos), tickets })
}

// The project that owns a git repo
export async function projectForRepo(db: D1Database, rawRepo: string) {
  const repo = Repo.parse(rawRepo)
  const row = await db
    .prepare(`SELECT key FROM projects WHERE instr(',' || repos || ',', ?)`)
    .bind(`,${repo},`)
    .first<{ key: string }>()
  if (!row) throw new HttpError(404, `no project has repo ${repo}. Add it: project key=ABC repos=[${repo}]`)
  return getProject(db, row.key)
}

export async function saveProject(db: D1Database, input: unknown) {
  const p = ProjectInput.parse(input)
  let description = p.description
  if (p.edits) {
    const cur = await db.prepare('SELECT description FROM projects WHERE key = ?').bind(p.key).first<{ description: string | null }>()
    if (!cur) throw new HttpError(404, `project ${p.key} not found`)
    description = applyEdits(description ?? cur.description ?? '', p.edits)
  }
  // One project per repo, so a repo lookup is never ambiguous
  if (p.repos?.length) {
    const { results } = await db
      .prepare(`SELECT key, repos FROM projects WHERE key != ? AND repos != ''`)
      .bind(p.key)
      .all<{ key: string; repos: string }>()
    for (const o of results) {
      const dup = p.repos.find((r) => o.repos.split(',').includes(r))
      if (dup) throw new HttpError(409, `repo ${dup} is in project ${o.key}`)
    }
  }
  const repos = p.repos && joinList(p.repos)
  const upd = await db
    .prepare(
      `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), repos = COALESCE(?, repos)
      WHERE key = ? RETURNING key`,
    )
    .bind(p.name ?? null, description ?? null, repos ?? null, p.key)
    .first()
  if (upd) return p.key
  if (!p.name) throw new HttpError(404, `project ${p.key} not found. Give a name to create it`)
  await db
    .prepare('INSERT INTO projects (key, name, description, repos) VALUES (?, ?, ?, ?)')
    .bind(p.key, p.name, description ?? null, repos ?? '')
    .run()
  return p.key
}

export async function listTickets(db: D1Database, input: ListOpts) {
  const o = ListInput.parse(input)
  const where: string[] = []
  const args: unknown[] = []
  if (o.project) where.push('t.project = ?'), args.push(o.project)
  if (o.status?.length) {
    where.push(`t.status IN (${o.status.map(() => '?').join(', ')})`), args.push(...o.status)
  } else if (!o.all) where.push(`t.status NOT IN ${CLOSED}`)
  if (o.assignee) where.push('t.assignee = ?'), args.push(o.assignee)
  if (o.parent) where.push('t.parent = ?'), args.push(o.parent)
  if (o.label) where.push(`instr(',' || t.labels || ',', ?)`), args.push(`,${o.label},`)
  if (o.q) {
    const like = `%${o.q.replace(/[\\%_]/g, '\\$&')}%`
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\')`), args.push(like, like)
  }

  // blocked_by lists only open blockers. Open tickets sort first, so a limit cuts closed ones.
  const { results } = await db
    .prepare(
      `SELECT t.id, t.status, t.title, t.labels, t.assignee, t.parent,
        (SELECT group_concat(d.blocked_by) FROM deps d JOIN tickets b ON b.id = d.blocked_by
          WHERE d.ticket = t.id AND b.status NOT IN ${CLOSED}) AS blocked_by
      FROM tickets t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.status IN ${CLOSED}, t.project, t.num LIMIT ?`,
    )
    .bind(...args, o.limit)
    .all()
  return results.map((r) => compact({ ...r, labels: split(r.labels), blocked_by: split(r.blocked_by) }))
}

export async function getTicket(db: D1Database, rawId: string, opts: { notes?: boolean } = {}) {
  const id = Id.parse(rawId)
  const stmts = [
    db.prepare('SELECT * FROM tickets WHERE id = ?').bind(id),
    db.prepare('SELECT blocked_by FROM deps WHERE ticket = ?').bind(id),
    db.prepare(`SELECT id, status, title FROM tickets WHERE parent = ? ORDER BY status IN ${CLOSED}, num`).bind(id),
  ]
  if (opts.notes) stmts.push(db.prepare('SELECT ts, text FROM notes WHERE ticket = ? ORDER BY id').bind(id))
  const [t, deps, kids, notes] = await db.batch<Record<string, unknown>>(stmts)
  const ticket = t.results[0]
  if (!ticket) throw new HttpError(404, `${id} not found`)
  const { project, num, ...rest } = ticket // both are in the id
  return compact({
    ...rest,
    labels: split(rest.labels),
    blocked_by: deps.results.map((r) => r.blocked_by),
    children: kids.results,
    notes: notes?.results,
  })
}

// Create (no id) or update (id) for each item. Not atomic across items.
export async function saveTickets(db: D1Database, items: unknown[]) {
  const ids: string[] = []
  for (const [i, item] of items.entries()) {
    try {
      const hasId = typeof item === 'object' && item !== null && 'id' in item
      ids.push(hasId ? await updateTicket(db, item) : await createTicket(db, item))
    } catch (e) {
      if (items.length === 1) throw e
      throw new HttpError(400, `item ${i} failed: ${errorInfo(e).error}. saved: ${ids.join(', ') || 'none'}`)
    }
  }
  return ids
}

async function createTicket(db: D1Database, input: unknown) {
  const t = CreateInput.parse(input)
  const slug = slugify(t.title)
  // One transaction: seq bump, insert, deps, note. Numbers never repeat.
  const [, ins] = await db.batch<{ id: string }>([
    db.prepare('UPDATE projects SET seq = seq + 1 WHERE key = ?').bind(t.project),
    db
      .prepare(
        `INSERT INTO tickets (id, project, num, title, status, assignee, branch, parent, pr, body, labels)
        SELECT key || '-' || seq, key, seq, ?, ?, ?, COALESCE(?, lower(key) || '-' || seq || ?), ?, ?, ?, ?
        FROM projects WHERE key = ? RETURNING id`,
      )
      .bind(
        t.title, t.status, t.assignee ?? null, t.branch ?? null, slug ? `-${slug}` : '',
        t.parent ?? null, t.pr ?? null, t.body, joinList(t.labels), t.project,
      ),
    ...t.blocked_by.map((b) => depStmt(db, NEW, t.project, b)),
    ...(t.note ? [noteStmt(db, NEW, t.project, t.note)] : []),
  ])
  const id = ins.results[0]?.id
  if (!id) throw new HttpError(404, `project ${t.project} not found`)
  return id
}

async function updateTicket(db: D1Database, input: unknown) {
  const u = UpdateInput.parse(input)
  if (u.parent === u.id || u.blocked_by?.includes(u.id)) throw new HttpError(400, `${u.id} cannot depend on itself`)

  let body = u.body
  if (u.edits) {
    const cur = await db.prepare('SELECT body FROM tickets WHERE id = ?').bind(u.id).first<{ body: string }>()
    if (!cur) throw new HttpError(404, `${u.id} not found`)
    body = applyEdits(body ?? cur.body, u.edits)
  }

  const sets = ["updated = datetime('now')"]
  const args: unknown[] = []
  const fields = {
    title: u.title, status: u.status, assignee: u.assignee, parent: u.parent, pr: u.pr, branch: u.branch, body,
    labels: u.labels && joinList(u.labels),
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) sets.push(`${k} = ?`), args.push(v)
  }

  const stmts = [db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ? RETURNING id`).bind(...args, u.id)]
  if (u.blocked_by) {
    stmts.push(db.prepare('DELETE FROM deps WHERE ticket = ?').bind(u.id))
    stmts.push(...u.blocked_by.map((b) => depStmt(db, OLD, u.id, b)))
  }
  if (u.note) stmts.push(noteStmt(db, OLD, u.id, u.note))

  const [upd] = await db.batch(stmts)
  if (!upd.results.length) throw new HttpError(404, `${u.id} not found`)
  return u.id
}

// From the GitHub webhook. Opened: link + move to doing. Merged: done. Both add the repo label.
export async function linkPr(db: D1Database, id: string, url: string, merged: boolean, repo: string) {
  const label = `repo:${repo.toLowerCase()}`
  const stmts = [
    db
      .prepare(
        `UPDATE tickets SET pr = ?, updated = datetime('now'),
          status = CASE WHEN ? THEN 'done' WHEN status IN ('backlog', 'todo') THEN 'doing' ELSE status END,
          labels = CASE WHEN instr(',' || labels || ',', ?) THEN labels WHEN labels = '' THEN ? ELSE labels || ',' || ? END
        WHERE id = ? RETURNING status`,
      )
      .bind(url, merged ? 1 : 0, `,${label},`, label, label, id),
  ]
  if (merged) stmts.push(noteStmt(db, OLD, id, `merged ${url}`))
  const [upd] = await db.batch<{ status: string }>(stmts)
  const status = upd.results[0]?.status
  return status ? `${id} ${status}` : `${id} not found, ignored`
}

// Delete cancelled tickets not updated for `days`, with their notes and deps. Sub-tickets lose the parent.
export async function purgeCancelled(db: D1Database, days = 30) {
  const age = `-${days} days`
  const old = `SELECT id FROM tickets WHERE status = 'cancelled' AND updated < datetime('now', ?)`
  const res = await db.batch<{ id: string }>([
    db.prepare(`DELETE FROM notes WHERE ticket IN (${old})`).bind(age),
    db.prepare(`DELETE FROM deps WHERE ticket IN (${old}) OR blocked_by IN (${old})`).bind(age, age),
    db.prepare(`UPDATE tickets SET parent = NULL WHERE parent IN (${old})`).bind(age),
    db.prepare(`DELETE FROM tickets WHERE id IN (${old}) RETURNING id`).bind(age),
  ])
  return res[3].results.map((r) => r.id)
}

// Ticket id as a SELECT: inserts join the batch and do nothing if the ticket is missing.
// NEW is the id that create's seq bump just made; bind the project key. OLD: bind the id.
const NEW = `SELECT key || '-' || seq, ? FROM projects WHERE key = ?`
const OLD = `SELECT id, ? FROM tickets WHERE id = ?`

const depStmt = (db: D1Database, from: string, ref: string, b: string) =>
  db.prepare(`INSERT OR IGNORE INTO deps (ticket, blocked_by) ${from}`).bind(b, ref)

const noteStmt = (db: D1Database, from: string, ref: string, text: string) =>
  db.prepare(`INSERT INTO notes (ticket, text) ${from}`).bind(text, ref)

// Each `old` must match exactly once
function applyEdits(body: string, edits: { old: string; new: string }[]) {
  for (const e of edits) {
    const n = body.split(e.old).length - 1
    if (n !== 1) throw new HttpError(400, `edit "${e.old.slice(0, 40)}" matched ${n} times, need 1`)
    body = body.replace(e.old, () => e.new)
  }
  return body
}

// Max 40 chars, cut at a word boundary
export function slugify(s: string) {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length <= 40 ? slug : slug.slice(0, 41).replace(/-[^-]*$/, '').slice(0, 40)
}

const joinList = (l: string[]) => [...new Set(l)].join(',')
const split = (v: unknown) => (v ? String(v).split(',') : undefined)

// Drop null, undefined and empty arrays to save tokens
function compact<T extends Record<string, unknown>>(o: T) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)),
  ) as Partial<T>
}
