import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'hono/utils/buffer'
import * as core from './core'
import { handleGithub } from './github'
import { handleMcp } from './mcp'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  const { status, error } = core.errorInfo(err)
  return c.json({ error }, status)
})

app.get('/', (c) => c.text('cradle'))

const api = new Hono<{ Bindings: Env }>()

const auth = bearerAuth({
  verifyToken: async (token, c) => {
    const want = (c.env as Env).TOKEN
    return !!want && (await timingSafeEqual(token, want)) // no TOKEN = deny all
  },
})

api.use(auth)

api.get('/projects', async (c) => c.json(await core.listProjects(c.env.DB)))

api.post('/projects', async (c) => c.json({ key: await core.createProject(c.env.DB, await c.req.json()) }, 201))

// ?project=ABC&status=todo,doing&assignee=sean&parent=ABC-1&q=text&all=1&limit=50
api.get('/tickets', async (c) => {
  const q = c.req.query()
  const tickets = await core.listTickets(c.env.DB, {
    project: q.project,
    status: q.status?.split(',') as core.ListOpts['status'],
    assignee: q.assignee,
    parent: q.parent,
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

app.all('/mcp', auth, (c) => handleMcp(c.req.raw, c.env.DB))

// Signed by GitHub, not the bearer token
app.post('/gh', async (c) => {
  const [status, text] = await handleGithub(c.req.raw, c.env)
  return c.text(text, status as 200 | 401)
})

export default app
