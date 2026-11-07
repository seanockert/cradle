// MCP over stateless Streamable HTTP. New server per request, JSON responses, no sessions.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import * as core from './core'
import { lines, projectLines, ticketMd } from './format'

const INSTRUCTIONS = `Cradle is a ticket tracker. IDs look like ABC-123. Each ticket has a git branch.
To work on a ticket: get it, check it against the latest main, fix stale facts (save with edits), check out its branch (create it if missing), save status doing. After opening a PR, save pr=<url>. Merging the PR sets status done if the repo has the cradle webhook; else set it yourself.
Use edits, not a full body, to change part of a body. Use note for progress and decisions.`

const Status = z.enum(core.STATUSES)
const Id = z.string().describe('e.g. ABC-123')

const SaveItem = z.object({
  id: Id.optional().describe('omit to create'),
  project: z.string().optional().describe('key, needed to create'),
  title: z.string().optional().describe('needed to create'),
  status: Status.optional(),
  assignee: z.string().nullable().optional(),
  parent: Id.nullable().optional(),
  blocked_by: z.array(Id).optional().describe('replaces the list'),
  body: z.string().optional().describe('markdown, replaces body'),
  edits: z
    .array(z.object({ old: z.string(), new: z.string() }))
    .optional()
    .describe('replace exact text in body, each old must match once'),
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

function server(db: D1Database) {
  const s = new McpServer({ name: 'cradle', version: '1.0.0' }, { instructions: INSTRUCTIONS })

  s.registerTool(
    'list',
    {
      description: 'List tickets, one line each, no body. Hides done and cancelled unless all=true or status is set.',
      inputSchema: {
        project: z.string().optional(),
        status: z.array(Status).optional(),
        assignee: z.string().optional(),
        parent: Id.optional(),
        q: z.string().optional().describe('text in title or body'),
        all: z.boolean().optional(),
        limit: z.number().int().optional().describe('default 50'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (a) => lines(await core.listTickets(db, { ...a, limit: a.limit ?? 50 }))),
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
    run(async (a) => (await core.saveTickets(db, a.items)).join(' ')),
  )

  s.registerTool(
    'project',
    {
      description: 'List projects. With key and name: create one. Key is the ticket prefix, 2-5 letters.',
      inputSchema: { key: z.string().optional(), name: z.string().optional(), description: z.string().optional() },
    },
    run(async (a) => (a.key ? await core.createProject(db, a) : projectLines(await core.listProjects(db)))),
  )

  return s
}

export async function handleMcp(req: Request, db: D1Database) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server(db).connect(transport)
  return transport.handleRequest(req)
}
