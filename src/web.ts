// Read-only HTML view: /t (open tickets), /t/p/:key (project), /t/:id, /t/:id.md (export), /t/connect (setup for agents and CLI). Token login, cookie session.
import { Hono, type MiddlewareHandler } from 'hono'
import { html, raw } from 'hono/html'
import { getCookie, setCookie } from 'hono/cookie'
import { Marked } from 'marked'
import * as core from './core'
import { exportMd, exportName, summary } from './format'
import { derive, mcpKey, same } from './secret'

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

// Layout classes (stack, inline) from https://seanockert.com/css-layouts
const CSS = `:root{--fg:#1c1c1c;--muted:#6e6e6e;--line:#e8e8e8;--soft:#f4f4f3;--bg:#fff;--link:#0b62d6;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--fg:#e4e4e4;--muted:#949494;--line:#2c2c2c;--soft:#222;--bg:#141414;--link:#6aa8ff}}
*{box-sizing:border-box}
body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:1.5rem 1.25rem 4rem;color:var(--fg);background:var(--bg)}
[class^=inline],[class*=' inline'],[class^=stack],[class*=' stack']{--gap:.75rem;display:flex;gap:var(--gap)}
[class^=inline],[class*=' inline']{align-items:center;flex-wrap:wrap}
[class^=stack],[class*=' stack']{flex-direction:column}
.inline-half,.stack-half{--gap:.375rem}.stack-2x{--gap:1.5rem}.inline-between{justify-content:space-between}
ul[class]{list-style:none;margin:0;padding:0}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
nav{padding-bottom:1rem;border-bottom:1px solid var(--line);font-size:.9rem}nav .brand{color:var(--fg);font-weight:600}
h1{font-size:1.6rem;line-height:1.25;margin:0}
h2{font-size:1.05rem;margin:2rem 0 .5rem}h2 a{color:inherit}
h3{font-size:.95rem;margin:1.5rem 0 .4rem}
.muted,.l{color:var(--muted)}.l{font-size:.8rem}.ctx{color:var(--muted);font-size:.9rem;margin:0 0 .5rem}
.id{font-family:ui-monospace,monospace;font-size:.8rem;color:var(--muted)}
.pill{display:inline-block;min-width:4.5rem;text-align:center;font-size:.75rem;padding:.05rem .5rem;border-radius:99px;color:var(--muted);background:color-mix(in srgb,currentColor 12%,transparent)}
.st-doing{color:#2563eb}.st-done{color:#16a34a}.st-cancelled{text-decoration:line-through}
.rows li{padding:.4rem 0;border-bottom:1px solid var(--line)}.rows li:last-child{border:0}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1.5rem;margin:0;font-size:.9rem}.meta dt{color:var(--muted)}.meta dd{margin:0}
.body{border-top:1px solid var(--line)}.body>:first-child{margin-top:1.5rem}
li:has(>input[type=checkbox]){list-style:none;margin-left:-1.3rem}li>input[type=checkbox]{margin:0 .5rem 0 0;vertical-align:-1px}
pre,code{font-family:ui-monospace,monospace;font-size:.85em}
:not(pre)>code{background:var(--soft);padding:.1rem .3rem;border-radius:4px}
pre{background:var(--soft);padding:.75rem 1rem;border-radius:6px;overflow-x:auto}
section>h2{margin:0}.note{font-size:.9rem}.note time{color:var(--muted);font-family:ui-monospace,monospace;font-size:.8rem;margin-right:.75rem}
input[type=password]{width:100%;padding:.5rem .6rem;font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit}
button{font:inherit;padding:.4rem 1rem;border:0;border-radius:6px;background:var(--fg);color:var(--bg);cursor:pointer}
.copy{position:relative}.copy pre{margin:0;padding-right:4.5rem}.copy button{position:absolute;top:.4rem;right:.4rem;font-size:.75rem;padding:.2rem .6rem}`

const nav = (links: unknown = '') =>
  html`<nav class="inline-between"><a class="brand" href="/t">cradle</a><span class="inline">${links}<a href="/t/connect">connect</a></span></nav>`

const page = (title: string, body: unknown) =>
  html`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${raw(CSS)}</style></head><body class="stack-2x">${body}</body></html>`

type Row = Record<string, any>

const idLink = (id: string) => html`<a class="id" href="/t/${id}">${id}</a>`

const labelLinks = (labels?: string[]) => labels?.map((l) => html` <a class="l" href="/t?label=${encodeURIComponent(l)}">#${l}</a>`) ?? ''

const item = (t: Row) =>
  html`<li class="inline-half"><span class="pill st-${t.status}">${t.status}</span> ${idLink(t.id)} ${t.title}${labelLinks(t.labels)}${
    t.assignee ? html` <small class="muted">@${t.assignee}</small>` : ''
  }</li>`

const list = (rows: Row[]) => html`<ul class="rows">${rows.map(item)}</ul>`

export const web = new Hono<App>()

web.use(auth)

web.onError((err, c) => {
  const { status, error } = core.errorInfo(err)
  return c.html(page('cradle', html`${nav()}<p>${error}</p>`), status)
})

// Redirect to /t paths only
const safeNext = (n?: string) => (n && /^\/t(\/[\w.-]+)*$/.test(n) ? n : '/t')

const loginPage = (next: string, error = '') =>
  page(
    'cradle login',
    html`${nav()}<form class="stack" method="post" action="/t/login"><input type="hidden" name="next" value="${next}">
${error ? html`<p class="muted" style="margin:0">${error}</p>` : ''}
<input type="password" name="token" placeholder="token" autofocus required>
<div><button>Log in</button></div></form>`,
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
      ? html`<section class="stack-half"><h2><a href="/t/p/${p.key}">${p.key} · ${p.name}</a></h2>${p.description ? html`<p class="ctx">${summary(p.description)}</p>` : ''}${list(rows)}</section>`
      : ''
  })
  return c.html(
    page(
      'cradle',
      html`${nav(html`${label ? html`<span class="muted">#${label}</span><a href="/t${all ? '?all=1' : ''}">all labels</a>` : ''}<a href="/t?${qs(!all)}">${all ? 'hide' : 'show'} done</a>`)}${
        tickets.length ? groups : html`<p>No tickets.</p>`
      }`,
    ),
  )
})

// Code block with a copy button
const copyBlock = (text: string) => html`<div class="copy"><pre><code>${text}</code></pre><button type="button">copy</button></div>`

const COPY_JS = `document.querySelectorAll('.copy button').forEach((b) => b.onclick = async () => {
  await navigator.clipboard.writeText(b.previousElementSibling.textContent); b.textContent = 'copied'; setTimeout(() => b.textContent = 'copy', 1500)
})`

web.get('/connect', async (c) => {
  const origin = new URL(c.req.url).origin
  const mcpUrl = `${origin}/mcp/${await mcpKey(c.env.TOKEN)}`
  const config = JSON.stringify({ mcpServers: { cradle: { type: 'http', url: mcpUrl } } }, null, 2)
  return c.html(
    page(
      'cradle connect',
      html`${nav()}
<header class="stack-half"><h1>Connect</h1><p class="ctx">This URL gives full access to your tickets over MCP. Share it only with people you trust.</p></header>
<section class="stack-half"><h2>Claude Code</h2><p class="ctx">Run in a terminal. Then restart Claude Code sessions.</p>
${copyBlock(`claude mcp add --scope user --transport http cradle ${mcpUrl}`)}</section>
<section class="stack-half"><h2>Claude Desktop and claude.ai</h2><p class="ctx">Settings, Connectors, Add custom connector. Use this URL.</p>
${copyBlock(mcpUrl)}</section>
<section class="stack-half"><h2>Other agents</h2><p class="ctx">MCP config, HTTP transport.</p>
${copyBlock(config)}</section>
<section class="stack-half"><h2>CLI</h2><p class="ctx">Needs <a href="https://bun.sh">Bun</a>. The login command asks for your token.</p>
${copyBlock(`bun install -g github:seanockert/cradle\ncradle login ${origin}`)}</section>
<script>${raw(COPY_JS)}</script>`,
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
      html`${nav()}
<header class="stack-half"><span class="id">${p.key}</span><h1>${p.name}</h1>${p.repos?.length ? html`<p class="ctx">repos: ${p.repos.join(', ')}</p>` : ''}</header>
${p.description ? html`<div class="body">${raw(await md.parse(p.description))}</div>` : html`<p class="muted">No context yet.</p>`}
<section class="stack-half"><h2>Open tickets</h2>${tickets.length ? list(tickets) : html`<p class="muted">None.</p>`}</section>`,
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
    ['status', html`<span class="pill st-${t.status}">${t.status}</span>`],
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
      html`${nav(html`<a href="/t/${t.id}.md">export .md</a>`)}
<header class="stack-half"><span class="id">${t.id}</span><h1>${t.title}</h1></header>
<dl class="meta">${rows.filter(([, v]) => v).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
${t.body ? html`<div class="body">${raw(await md.parse(t.body))}</div>` : ''}
${t.children?.length ? html`<section class="stack-half"><h2>Sub-tickets</h2>${list(t.children)}</section>` : ''}
${
  t.notes?.length
    ? html`<section class="stack-half"><h2>Notes</h2><ul class="rows">${t.notes.map((n: Row) => html`<li class="note"><time>${n.ts.slice(0, 16)}</time>${n.text}</li>`)}</ul></section>`
    : ''
}`,
    ),
  )
})
