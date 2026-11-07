// Ticket operations. REST, MCP and webhook all call these.
import { z } from 'zod'

export const STATUSES = ['backlog', 'todo', 'doing', 'done', 'cancelled'] as const
const CLOSED = `('done', 'cancelled')`

export class HttpError extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message)
  }
}

// Map any error to a status + short message an agent can act on
export function errorInfo(err: unknown): { status: 400 | 404 | 409 | 500; error: string } {
  if (err instanceof z.ZodError) return { status: 400, error: z.prettifyError(err) }
  if (err instanceof HttpError) return { status: err.status, error: err.message }
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
export const Id = z
  .string()
  .regex(/^[A-Za-z]{2,5}-\d+$/, 'ticket id must look like ABC-123')
  .transform((s) => s.toUpperCase())

export const ProjectInput = z.object({
  key: Key,
  name: z.string().min(1),
  description: z.string().optional(),
})

export const ListInput = z.object({
  project: Key.optional(),
  status: z.array(Status).optional(),
  assignee: z.string().optional(),
  parent: Id.optional(),
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
  edits: z.array(z.object({ old: z.string().min(1), new: z.string() })).optional(),
  blocked_by: z.array(Id).optional(),
  note: z.string().min(1).optional(),
})

export type ListOpts = z.input<typeof ListInput>

// --- projects ---

export async function listProjects(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT key, name, description,
        (SELECT count(*) FROM tickets t WHERE t.project = p.key AND t.status NOT IN ${CLOSED}) AS open
      FROM projects p ORDER BY key`,
    )
    .all()
  return results.map(compact)
}

export async function createProject(db: D1Database, input: unknown) {
  const p = ProjectInput.parse(input)
  await db
    .prepare('INSERT INTO projects (key, name, description) VALUES (?, ?, ?)')
    .bind(p.key, p.name, p.description ?? null)
    .run()
  return p.key
}

// --- tickets ---

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
  if (o.q) where.push('(t.title LIKE ? OR t.body LIKE ?)'), args.push(`%${o.q}%`, `%${o.q}%`)

  // blocked_by lists only open blockers
  const { results } = await db
    .prepare(
      `SELECT t.id, t.status, t.assignee, t.title, t.parent,
        (SELECT group_concat(d.blocked_by) FROM deps d JOIN tickets b ON b.id = d.blocked_by
          WHERE d.ticket = t.id AND b.status NOT IN ${CLOSED}) AS blocked_by
      FROM tickets t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.project, t.num LIMIT ?`,
    )
    .bind(...args, o.limit)
    .all()
  return results.map((r) => compact({ ...r, blocked_by: (r.blocked_by as string | null)?.split(',') }))
}

export async function getTicket(db: D1Database, rawId: string, opts: { notes?: boolean } = {}) {
  const id = Id.parse(rawId)
  const stmts = [
    db.prepare('SELECT * FROM tickets WHERE id = ?').bind(id),
    db.prepare('SELECT blocked_by FROM deps WHERE ticket = ?').bind(id),
    db.prepare('SELECT id, status, title FROM tickets WHERE parent = ? ORDER BY num').bind(id),
  ]
  if (opts.notes) stmts.push(db.prepare('SELECT ts, text FROM notes WHERE ticket = ? ORDER BY id').bind(id))
  const [t, deps, kids, notes] = await db.batch<Record<string, unknown>>(stmts)
  const ticket = t.results[0]
  if (!ticket) throw new HttpError(404, `${id} not found`)
  const { project, num, ...rest } = ticket // both are in the id
  return compact({
    ...rest,
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
      const msg = e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message
      throw new HttpError(400, `item ${i} failed: ${msg}. saved: ${ids.join(', ') || 'none'}`)
    }
  }
  return ids
}

async function createTicket(db: D1Database, input: unknown) {
  const t = CreateInput.parse(input)
  const slug = slugify(t.title)
  // seq bump + insert in one transaction, so numbers never repeat
  const [, ins] = await db.batch<{ id: string }>([
    db.prepare('UPDATE projects SET seq = seq + 1 WHERE key = ?').bind(t.project),
    db
      .prepare(
        `INSERT INTO tickets (id, project, num, title, status, assignee, branch, parent, pr, body)
        SELECT key || '-' || seq, key, seq, ?, ?, ?, COALESCE(?, lower(key) || '-' || seq || ?), ?, ?, ?
        FROM projects WHERE key = ? RETURNING id`,
      )
      .bind(
        t.title, t.status, t.assignee ?? null, t.branch ?? null, slug ? `-${slug}` : '',
        t.parent ?? null, t.pr ?? null, t.body, t.project,
      ),
  ])
  const id = ins.results[0]?.id
  if (!id) throw new HttpError(404, `project ${t.project} not found`)

  const extra = [
    ...t.blocked_by.map((b) => depStmt(db, id, b)),
    ...(t.note ? [noteStmt(db, id, t.note)] : []),
  ]
  if (extra.length) await db.batch(extra)
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
  const fields = { title: u.title, status: u.status, assignee: u.assignee, parent: u.parent, pr: u.pr, branch: u.branch, body }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) sets.push(`${k} = ?`), args.push(v)
  }

  const stmts = [db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ? RETURNING id`).bind(...args, u.id)]
  if (u.blocked_by) {
    stmts.push(db.prepare('DELETE FROM deps WHERE ticket = ?').bind(u.id))
    stmts.push(...u.blocked_by.map((b) => depStmt(db, u.id, b)))
  }
  if (u.note) stmts.push(noteStmt(db, u.id, u.note))

  const [upd] = await db.batch(stmts)
  if (!upd.results.length) throw new HttpError(404, `${u.id} not found`)
  return u.id
}

// From the GitHub webhook. Opened: link + move to doing. Merged: done.
export async function linkPr(db: D1Database, id: string, url: string, merged: boolean) {
  const t = await db.prepare('SELECT status FROM tickets WHERE id = ?').bind(id).first<{ status: string }>()
  if (!t) return `${id} not found, ignored`
  const item: Record<string, unknown> = { id, pr: url }
  if (merged) item.status = 'done', item.note = `merged ${url}`
  else if (t.status === 'backlog' || t.status === 'todo') item.status = 'doing'
  await updateTicket(db, item)
  return `${id} ${item.status ?? t.status}`
}

// --- helpers ---

const depStmt = (db: D1Database, id: string, b: string) =>
  db.prepare('INSERT OR IGNORE INTO deps (ticket, blocked_by) VALUES (?, ?)').bind(id, b)

const noteStmt = (db: D1Database, id: string, text: string) =>
  db.prepare('INSERT INTO notes (ticket, text) VALUES (?, ?)').bind(id, text)

// Each `old` must match exactly once, like str_replace
function applyEdits(body: string, edits: { old: string; new: string }[]) {
  for (const e of edits) {
    const n = body.split(e.old).length - 1
    if (n !== 1) throw new HttpError(400, `edit "${e.old.slice(0, 40)}" matched ${n} times, need 1`)
    body = body.replace(e.old, () => e.new)
  }
  return body
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
}

// Drop null, undefined and empty arrays to save tokens
function compact<T extends Record<string, unknown>>(o: T) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)),
  ) as Partial<T>
}
