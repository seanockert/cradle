import { Hono, type MiddlewareHandler } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'
import * as core from './core'
import { handleGithub } from './github'
import { mcpKey, same } from './secret'
import { handleMcp } from './mcp'
import { web } from './web'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  const { status, error } = core.errorInfo(err)
  return c.json({ error }, status)
})

app.get('/', (c) => c.text('cradle'))

const api = new Hono<{ Bindings: Env }>()

api.use(bearerAuth({ verifyToken: (token, c) => same(token, (c.env as Env).TOKEN) }))

api.get('/projects', async (c) => c.json(await core.listProjects(c.env.DB)))

api.get('/repos/:repo', async (c) => c.json(await core.projectForRepo(c.env.DB, c.req.param('repo'))))

api.get('/projects/:key', async (c) => c.json(await core.getProject(c.env.DB, c.req.param('key'))))

// Create, or update given fields
api.post('/projects', async (c) => c.json({ key: await core.saveProject(c.env.DB, await c.req.json()) }))

api.patch('/projects/:key', async (c) =>
  c.json({ key: await core.saveProject(c.env.DB, { ...(await c.req.json()), key: c.req.param('key') }) }),
)

// ?project=ABC&status=todo,doing&assignee=sean&parent=ABC-1&label=bug&q=text&all=1&limit=50
api.get('/tickets', async (c) => {
  const q = c.req.query()
  const tickets = await core.listTickets(c.env.DB, {
    project: q.project,
    status: q.status?.split(',') as core.ListOpts['status'],
    assignee: q.assignee,
    parent: q.parent,
    label: q.label,
    q: q.q,
    all: q.all === '1',
    limit: q.limit ? Number(q.limit) : undefined,
  })
  return c.json(tickets)
})

api.get('/tickets/:id', async (c) =>
  c.json(await core.getTicket(c.env.DB, c.req.param('id'), { notes: c.req.query('notes') === '1' })),
)

// One ticket or an array. Items with `id` update, items without create.
api.post('/tickets', async (c) => {
  const body = await c.req.json()
  return c.json({ ids: await core.saveTickets(c.env.DB, Array.isArray(body) ? body : [body]) })
})

api.patch('/tickets/:id', async (c) => {
  const body = await c.req.json()
  return c.json({ ids: await core.saveTickets(c.env.DB, [{ ...body, id: c.req.param('id') }]) })
})

app.route('/api', api)

// MCP auth: key in URL (/mcp/<key>) or bearer header (/mcp).
// Fail with 403, not 401: a 401 makes MCP clients start an OAuth flow, which cradle does not have.
const mcpAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const want = c.env.TOKEN
  const key = c.req.param('key')
  const ok = key
    ? want && (await same(key, await mcpKey(want)))
    : await same(c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1], want)
  if (ok) return next()
  const message = 'cradle: bad or missing key. Run `cradle mcp` to get the URL.'
  return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }, 403)
}

const mcp = (c: { req: { raw: Request }; env: Env }) => handleMcp(c.req.raw, c.env.DB)
app.all('/mcp', mcpAuth, mcp)
app.all('/mcp/:key', mcpAuth, mcp)

app.route('/t', web)

// Signed by GitHub, not the bearer token
app.post('/gh', async (c) => {
  const [status, text] = await handleGithub(c.req.raw, c.env)
  return c.text(text, status)
})

export default app
