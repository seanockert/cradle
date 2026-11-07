// MCP over stateless Streamable HTTP. New server per request, JSON responses, no sessions.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import * as core from './core'
import { lines, missing, projectLines, projectMd, ticketMd } from './format'

const instructions = (origin: string) => `Cradle is a ticket tracker. IDs look like ABC-123. Each ticket has a git branch.
Each project (the ABC in ABC-123) owns git repos and has a goal and context: ## Goal, ## Constraints, ## Not in scope. Find it with project repo=<git repo name> and read it once before you work on its tickets. If no project owns the repo, ask the user which project to add it to. Keep the work aligned with the goal. If the goal changes, update it.
Write each ticket so another agent can do and verify the work with no other context:
- Title: imperative, one outcome.
- Body: ## Goal (why, 1-3 sentences, linked to the project goal). ## Done when (- [ ] list, each item testable). ## Verify (commands or steps that prove each item). Add ## Context (files, links, limits) only if needed.
- Short sentences, one instruction each, no filler (ASD-STE100 style).
- One type label (bug, feature, improvement, chore) and repo:<git repo name>.
To work on a ticket: get it, check it against the latest main, fix stale facts (save with edits), check out its branch (create it if missing), save status doing. Use note for progress and decisions.
Before you open a PR: run Verify and tick each Done when item (save with edits). If an item fails, fix it or add a note. Do not skip it. After opening a PR, save pr=<url>. Merging the PR sets status done if the repo has the cradle webhook; else set it yourself.
Use edits, not a full body, to change part of a body.
Ticket page for PR bodies: ${origin}/t/<id>`

const Status = z.enum(core.STATUSES)
const Id = z.string()

// core validates; this schema only guides the agent, so keep it short
const Edits = z
  .array(z.object({ old: z.string(), new: z.string() }))
  .optional()
  .describe('replace exact text, each old must match once')

const SaveItem = z.object({
  id: Id.optional().describe('ABC-123. Omit to create'),
  project: z.string().optional().describe('key, needed to create'),
  title: z.string().optional().describe('needed to create'),
  status: Status.optional(),
  assignee: z.string().nullable().optional(),
  parent: Id.nullable().optional(),
  blocked_by: z.array(Id).optional().describe('replaces the list'),
  labels: z.array(z.string()).optional().describe('replaces the list'),
  body: z.string().optional().describe('markdown, replaces body'),
  edits: Edits,
  pr: z.string().nullable().optional(),
  branch: z.string().optional(),
  note: z.string().optional().describe('append to log'),
})

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }

// Run a tool, return text. Errors go back to the agent as text so it can fix the call.
const run =
  <A>(fn: (args: A) => Promise<string>) =>
  async (args: A): Promise<Text> => {
    try {
      return { content: [{ type: 'text', text: await fn(args) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: core.errorInfo(e).error }], isError: true }
    }
  }

function server(db: D1Database, origin: string) {
  const s = new McpServer({ name: 'cradle', version: '1.0.0' }, { instructions: instructions(origin) })

  s.registerTool(
    'list',
    {
      description: 'List tickets, one line each, no body. Hides done and cancelled unless all=true or status is set.',
      inputSchema: {
        project: z.string().optional(),
        status: z.array(Status).optional(),
        assignee: z.string().optional(),
        parent: Id.optional(),
        label: z.string().optional(),
        q: z.string().optional().describe('text in title or body'),
        all: z.boolean().optional(),
        limit: z.number().int().optional().describe('default 50'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (a) => {
      // Fetch one extra row to tell the agent when the list is cut off
      const limit = Math.min(a.limit ?? 50, 499)
      const rows = await core.listTickets(db, { ...a, limit: limit + 1 })
      const more = rows.length > limit ? `\n(more: narrow the filter or raise limit)` : ''
      return lines(rows.slice(0, limit)) + more
    }),
  )

  s.registerTool(
    'get',
    {
      description: 'Get one ticket as markdown: fields, branch, body, sub-tickets. notes=true adds the log.',
      inputSchema: { id: Id, notes: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    run(async (a) => ticketMd(await core.getTicket(db, a.id, a)).trimEnd()),
  )

  s.registerTool(
    'save',
    {
      description:
        'Create or update tickets in one call. Without id: create. With id: change only given fields, null clears. Returns ids.',
      inputSchema: { items: z.array(SaveItem).min(1) },
    },
    run(async (a) => {
      const ids = await core.saveTickets(db, a.items)
      // Warn, do not block: new tickets should follow the body standard
      const warn = ids
        .map((id, i) => !a.items[i].id && missing(a.items[i].body).length && `${id} missing ${missing(a.items[i].body).map((h) => `## ${h}`).join(', ')}`)
        .filter(Boolean)
      return [ids.join(' '), ...warn].join('\n') + (warn.length ? '\nAdd them with edits.' : '')
    }),
  )

  s.registerTool(
    'project',
    {
      description:
        'No args: list projects. repo or key only: get goal and context. key + other fields: create (needs name) or update. Key is the ticket prefix.',
      inputSchema: {
        key: z.string().optional(),
        repo: z.string().optional().describe('git repo name: get the project that owns it'),
        repos: z.array(z.string()).optional().describe('git repo names it owns, replaces the list'),
        name: z.string().optional(),
        description: z.string().optional().describe('markdown goal and context, replaces it'),
        edits: Edits,
      },
    },
    run(async ({ key, repo, ...rest }) => {
      if (!key && repo) return projectMd(await core.projectForRepo(db, repo)).trimEnd()
      if (!key) return projectLines(await core.listProjects(db))
      if (Object.values(rest).every((v) => v === undefined)) return projectMd(await core.getProject(db, key)).trimEnd()
      return core.saveProject(db, { key, ...rest })
    }),
  )

  return s
}

export async function handleMcp(req: Request, db: D1Database) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server(db, new URL(req.url).origin).connect(transport)
  return transport.handleRequest(req)
}
