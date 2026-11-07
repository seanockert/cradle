// Read-only HTML view: /t (open tickets), /t/p/:key (project), /t/:id, /t/:id.md (export). Token login, cookie session.
import { Hono, type MiddlewareHandler } from 'hono'
import { html, raw } from 'hono/html'
import { getCookie, setCookie } from 'hono/cookie'
import { Marked } from 'marked'
import * as core from './core'
import { exportMd, exportName, summary } from './format'
import { derive, same } from './secret'

type App = { Bindings: Env }

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Raw HTML in markdown is shown as text. Only http(s), mailto and relative links.
const md = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => esc(text),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      return /^(https?:|mailto:|\/|#)/i.test(href) ? `<a href="${esc(href)}">${text}</a>` : text
    },
  },
})

// Login: paste TOKEN once, get a 30-day cookie. Cookie value is derived from TOKEN, so changing TOKEN logs out.
const COOKIE = 'cradle'
const session = (env: Env) => derive(env.TOKEN, 'web')

const auth: MiddlewareHandler<App> = async (c, next) => {
  if (c.req.path === '/t/login') return next()
  if (c.env.TOKEN && (await same(getCookie(c, COOKIE), await session(c.env)))) return next()
  return c.redirect(`/t/login?next=${encodeURIComponent(c.req.path)}`)
}

const CSS = `body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
a{color:#0b62d6;text-decoration:none}a:hover{text-decoration:underline}
h2{margin-top:2rem;font-size:1.1rem}ul{padding-left:1.2rem}li{margin:.2rem 0}
.s{display:inline-block;min-width:4.5rem;font-size:.8rem;color:#666}.id{font-family:ui-monospace,monospace;font-size:.85rem}.l{font-size:.8rem;color:#888}.ctx{margin:-.5rem 0 .5rem;color:#666;font-size:.9rem}
table{border-collapse:collapse;font-size:.9rem;margin:1rem 0}td{padding:.15rem 1rem .15rem 0;vertical-align:top}td:first-child{color:#666}
pre,code{font-family:ui-monospace,monospace;font-size:.85rem}pre{background:#f4f4f4;padding:.7rem;overflow-x:auto}
.body{border-top:1px solid #ddd;margin-top:1rem}.note{font-size:.9rem}.note span{color:#666;margin-right:.5rem}
@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}a{color:#6aa8ff}pre{background:#222}.body{border-color:#333}}`

const page = (title: string, body: unknown) =>
  html`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${raw(CSS)}</style></head><body>${body}</body></html>`

type Row = Record<string, any>

const idLink = (id: string) => html`<a class="id" href="/t/${id}">${id}</a>`

const labelLinks = (labels?: string[]) => labels?.map((l) => html` <a class="l" href="/t?label=${encodeURIComponent(l)}">#${l}</a>`) ?? ''

const item = (t: Row) =>
  html`<li><span class="s">${t.status}</span> ${idLink(t.id)} ${t.title}${labelLinks(t.labels)}${
    t.assignee ? html` <small>@${t.assignee}</small>` : ''
  }</li>`

export const web = new Hono<App>()

web.use(auth)

web.onError((err, c) => {
  const { status, error } = core.errorInfo(err)
  return c.html(page('cradle', html`<a href="/t">← all</a><p>${error}</p>`), status)
})

// Redirect to /t paths only
const safeNext = (n?: string) => (n && /^\/t(\/[\w.-]+)*$/.test(n) ? n : '/t')

const loginPage = (next: string, error = '') =>
  page(
    'cradle login',
    html`<h1>cradle</h1>${error ? html`<p>${error}</p>` : ''}
<form method="post" action="/t/login"><input type="hidden" name="next" value="${next}">
<input type="password" name="token" placeholder="token" autofocus required style="width:100%;padding:.5rem;font:inherit">
<p><button>Log in</button></p></form>`,
  )

web.get('/login', (c) => c.html(loginPage(safeNext(c.req.query('next')))))

web.post('/login', async (c) => {
  const form = await c.req.parseBody()
  const next = safeNext(String(form.next ?? ''))
  const token = String(form.token ?? '')
  if (!(await same(token, c.env.TOKEN))) return c.html(loginPage(next, 'Wrong token.'), 401)
  setCookie(c, COOKIE, await session(c.env), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/t',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.redirect(next)
})

web.get('/', async (c) => {
  const all = c.req.query('all') === '1'
  const label = c.req.query('label') || undefined
  const [projects, tickets] = await Promise.all([
    core.listProjects(c.env.DB),
    core.listTickets(c.env.DB, { all, label, limit: 500 }),
  ])
  const qs = (a: boolean) => new URLSearchParams({ ...(a && { all: '1' }), ...(label && { label }) }).toString()
  const groups = projects.map((p: Row) => {
    const rows = tickets.filter((t: Row) => t.id.startsWith(`${p.key}-`))
    return rows.length
      ? html`<h2><a href="/t/p/${p.key}">${p.key} · ${p.name}</a></h2>${p.description ? html`<p class="ctx">${summary(p.description)}</p>` : ''}<ul>${rows.map(item)}</ul>`
      : ''
  })
  return c.html(
    page(
      'cradle',
      html`<h1>cradle${label ? html` · #${label}` : ''}</h1><a href="/t?${qs(!all)}">${all ? 'hide' : 'show'} done</a>${
        label ? html` · <a href="/t${all ? '?all=1' : ''}">all labels</a>` : ''
      }${
        tickets.length ? groups : html`<p>No tickets.</p>`
      }`,
    ),
  )
})

web.get('/p/:key', async (c) => {
  const [p, tickets] = await Promise.all([
    core.getProject(c.env.DB, c.req.param('key')),
    core.listTickets(c.env.DB, { project: c.req.param('key'), limit: 500 }),
  ])
  return c.html(
    page(
      `${p.key} ${p.name}`,
      html`<a href="/t">← all</a>
<h1>${p.key} · ${p.name}</h1>${p.repos?.length ? html`<p class="ctx">repos: ${p.repos.join(', ')}</p>` : ''}
${p.description ? html`<div class="body">${raw(await md.parse(p.description))}</div>` : html`<p>No context yet.</p>`}
<h2>Open tickets</h2>${tickets.length ? html`<ul>${tickets.map(item)}</ul>` : html`<p>None.</p>`}`,
    ),
  )
})

web.get('/:file{[A-Za-z]{2,5}-\\d+\\.md}', async (c) => {
  const t = await core.getTicket(c.env.DB, c.req.param('file').slice(0, -3), { notes: true })
  c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportName(t))}`)
  return c.body(exportMd(t), 200, { 'content-type': 'text/markdown; charset=utf-8' })
})

web.get('/:id', async (c) => {
  const t: Row = await core.getTicket(c.env.DB, c.req.param('id'), { notes: true })
  const rows: [string, unknown][] = [
    ['status', t.status],
    ['labels', t.labels?.length && labelLinks(t.labels)],
    ['assignee', t.assignee],
    ['branch', t.branch && html`<code>${t.branch}</code>`],
    ['pr', t.pr && html`<a href="${/^https?:/.test(t.pr) ? t.pr : '#'}">${t.pr}</a>`],
    ['parent', t.parent && idLink(t.parent)],
    ['blocked by', t.blocked_by?.length && t.blocked_by.map((b: string) => html`${idLink(b)} `)],
    ['updated', t.updated],
  ]
  return c.html(
    page(
      `${t.id} ${t.title}`,
      html`<a href="/t">← all</a> · <a href="/t/${t.id}.md">export .md</a>
<h1><span class="id">${t.id}</span> ${t.title}</h1>
<table>${rows.filter(([, v]) => v).map(([k, v]) => html`<tr><td>${k}</td><td>${v}</td></tr>`)}</table>
${t.body ? html`<div class="body">${raw(await md.parse(t.body))}</div>` : ''}
${t.children?.length ? html`<h2>Sub-tickets</h2><ul>${t.children.map(item)}</ul>` : ''}
${
  t.notes?.length
    ? html`<h2>Notes</h2>${t.notes.map((n: Row) => html`<p class="note"><span>${n.ts.slice(0, 16)}</span>${n.text}</p>`)}`
    : ''
}`,
    ),
  )
})
