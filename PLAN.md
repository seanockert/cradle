# Cradle

Headless ticket tracker for AI agents. Hono on Cloudflare Workers, D1 storage. Access through MCP, CLI and REST. Single user in v1.

## Goals

- Low token cost for lookup and management.
- One backlog across all projects and devices.
- Works with any agent harness (MCP + CLI).
- Each ticket gives a git branch name, like Linear.

## Not in v1

Images and attachments (no R2), priority, sort order, custom statuses, more than one user, a full UI.

## Layout

One package, no monorepo.

```
src/core.ts    ticket operations + zod schemas (one source of truth)
src/index.ts   Hono: /api (REST), /mcp, /t/:id (view), /gh (webhook)
src/format.ts  compact text output (CLI + MCP)
src/mcp.ts     MCP server, 4 tools
src/cli.ts     `cradle` CLI (Bun), calls /api
migrations/    D1 SQL
```

REST and MCP call the same `core` functions. They cannot drift.

## Data (D1)

```sql
projects(key PK, name, description, seq)                -- key: 2-5 uppercase letters, e.g. ABC
tickets(id PK, project, num, title, status, assignee, branch, parent, pr,
        body, created, updated)                  -- id: ABC-123
deps(ticket, blocked_by)
notes(id, ticket, ts, text)                      -- append-only
```

- Ticket numbers are per project. Get the next number with `UPDATE projects SET seq = seq + 1 WHERE key = ? RETURNING seq`, and run it in the same D1 batch as the insert.
- Status: `backlog | todo | doing | done | cancelled`.
- Branch: `abc-123-<title-slug>`, max 50 chars. You can override it.
- `parent` gives sub-tickets. `deps` gives blocked-by. The software shows both but does not apply rules to them.
- Search: `LIKE` on title + body. Fast enough at personal scale. No FTS5.
- Edits: last write wins (v1).

## Auth

- v1: one bearer token, kept as a Worker secret. The CLI reads it from `~/.config/cradle/config`.
- `/t/:id`: Cloudflare Access (free, no auth code).
- `/gh`: GitHub HMAC signature (`GH_WEBHOOK_SECRET`).
- Later: `users` table, one token per user. `assignee` is already a handle.

## MCP (done)

`src/mcp.ts`. Stateless Streamable HTTP, JSON responses, new server per request, no Durable Objects. Same bearer token as REST. Tool definitions total about 2.8 KB (about 700 tokens).

| Tool | Does | Returns |
|---|---|---|
| `list` | Filter by project, status, assignee or text. Done is hidden by default. | `ABC-123 todo @sean Fix auth redirect` per line |
| `get` | One ticket. `notes:true` adds the log. | Markdown + frontmatter: status, assignee, branch, pr, parent, blocked_by |
| `save` | Create or update. Takes an array. Edits body with `edits: [{old,new}]`. `note` appends to the log. | IDs only |
| `project` | List or create projects. | Compact lines |

Rules: tool descriptions under 30 words. Lists never include body. Default limit 20.

Server `instructions` (sent once when the agent connects):

> To work on a ticket: get it, check it against the latest main, fix stale facts (save with edits), check out its branch (create it if missing), save status doing. After opening a PR, save pr=<url>. When the work is merged, save status done.

After step 4, change the last sentence: the webhook sets `done`.

## CLI (`cradle`) (done)

Bun script, linked with `bun link`. Run `cradle --help` for usage.

```
cradle ls [-p ABC] [-s todo,doing] [-a name] [-q text] [--parent ID] [--all]
cradle show ID [-n]
cradle new "Title" [-p ABC] [-s status] [-a name] [-b body | -f file|-] [--parent ID] [--blocked-by ID,ID]
cradle edit ID [-t title] [-s status] [-a name] [--pr url] [--parent ID] [--blocked-by ID,ID] [-b body | -f file|-]
cradle edit ID -e             # $EDITOR, saves changed fields only
cradle mv ID [ID...] STATUS
cradle note ID "text"
cradle start ID               # status=doing + git checkout (creates branch if needed)
cradle branch ID
cradle import FILE|- [-p ABC] [-s status] [--split]
cradle project [new KEY "Name" [description]]
cradle config URL TOKEN       # writes ~/.config/cradle/config.json (or use CRADLE_URL, CRADLE_TOKEN)
--json                        # compact JSON
```

- Default project for `new` and `import`: `-p`, then `CRADLE_PROJECT`, then a `.cradle` file (contains `ABC`) in this or a parent dir.
- Import: H1 or frontmatter `title` becomes the title, else the file name. `--split` makes each `##` section a sub-ticket under one parent.
- Dropped for simplicity: `search` (use `ls -q`), `board`.
- Later: `cradle gh hook owner/repo` (step 4).

## GitHub webhook (`POST /gh`)

1. Check the HMAC signature.
2. Read the `pull_request` event. Get the ticket ID from the head branch (`^([a-z]{2,5})-(\d+)`, ignore case). If the branch does not match, use the PR title.
3. `opened` / `reopened`: set `pr`. If status is `backlog` or `todo`, set it to `doing`.
4. `closed` + `merged: true`: set status `done`. Add the note `merged <url>`.
5. `closed`, not merged: no change.
6. Ignore unknown tickets. Return 200.

A personal GitHub account has no webhook for all repos, so add one per repo with `cradle gh hook`.

## REST (done)

```
GET   /api/projects
POST  /api/projects        {key, name, description?}
GET   /api/tickets          ?project&status=a,b&assignee&parent&q&all=1&limit
GET   /api/tickets/:id      ?notes=1
POST  /api/tickets          one item or array. With id = update, no id = create
PATCH /api/tickets/:id      update fields, edits, blocked_by (replaces), note
```

Responses drop null and empty fields.

## Build order

1. ~~`core` + D1 migrations + REST + token auth.~~ Done.
2. ~~CLI.~~ Done.
3. ~~MCP.~~ Done. Connected in Claude Code at user scope.
4. `/gh` webhook + `cradle gh hook`.
5. `/t/:id` read-only view behind Cloudflare Access.
6. Later: more users.
