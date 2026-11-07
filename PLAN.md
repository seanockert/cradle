# Cradle

Headless ticket tracker for AI agents. Hono on Cloudflare Workers, D1 storage. Access through MCP, CLI and REST. Single user in v1.

## Goals

- Low token cost for lookup and management.
- One backlog across all projects and devices.
- Works with any agent harness (MCP + CLI).
- Each ticket gives a git branch name, like Linear.

## Not in v1

Paid Cloudflare plans (free tier only), images and attachments (no R2), priority, sort order, custom statuses, more than one user, a full UI.

## Layout

One package, no monorepo.

```
src/core.ts    ticket operations + zod schemas (one source of truth)
src/index.ts   Hono: /api (REST), /mcp, /t/:id (view), /gh (webhook)
src/format.ts  compact text output (CLI + MCP)
src/mcp.ts     MCP server, 4 tools
src/github.ts  PR webhook
src/web.ts     /t read-only HTML + login
src/secret.ts  values derived from TOKEN
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
- `/t`: paste TOKEN at `/t/login` once. Sets an HttpOnly cookie (30 days, path `/t`) whose value is derived from TOKEN. Changing TOKEN logs out. No Cloudflare Access, so no Zero Trust plan.
- `/gh`: GitHub HMAC signature. Secret derived from `TOKEN`.
- Later: `users` table, one token per user. `assignee` is already a handle.

## MCP (done)

`src/mcp.ts`. Stateless Streamable HTTP, JSON responses, new server per request, no Durable Objects. Auth: key in URL (`/mcp/<key>`, derived from TOKEN, MCP only) or bearer TOKEN on `/mcp`. Fails with 403, not 401, so clients do not start OAuth. `cradle mcp add` sets up Claude Code; `cradle mcp` prints the URL + config. Tool definitions total about 2.8 KB (about 700 tokens).

| Tool | Does | Returns |
|---|---|---|
| `list` | Filter by project, status, assignee or text. Done is hidden by default. | `ABC-123 todo @sean Fix auth redirect` per line |
| `get` | One ticket. `notes:true` adds the log. | Markdown + frontmatter: status, assignee, branch, pr, parent, blocked_by |
| `save` | Create or update. Takes an array. Edits body with `edits: [{old,new}]`. `note` appends to the log. | IDs only |
| `project` | List or create projects. | Compact lines |

Rules: tool descriptions under 30 words. Lists never include body. Default limit 20.

Server `instructions` (sent once when the agent connects):

> To work on a ticket: get it, check it against the latest main, fix stale facts (save with edits), check out its branch (create it if missing), save status doing. After opening a PR, save pr=<url>. Merging the PR sets status done if the repo has the cradle webhook; else set it yourself.

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
cradle mcp [add]              # MCP URL + config, or add to Claude Code
cradle gh hook [owner/repo]   # PR opened -> doing, merged -> done
cradle config URL TOKEN       # writes ~/.config/cradle/config.json (or use CRADLE_URL, CRADLE_TOKEN)
--json                        # compact JSON
```

- Default project for `new` and `import`: `-p`, then `CRADLE_PROJECT`, then a `.cradle` file (contains `ABC`) in this or a parent dir.
- Import: H1 or frontmatter `title` becomes the title, else the file name. `--split` makes each `##` section a sub-ticket under one parent.
- Dropped for simplicity: `search` (use `ls -q`), `board`.

## GitHub webhook (done)

`src/github.ts`, route `POST /gh`.

- Secret: `sha256("cradle-gh:" + TOKEN)` (`src/secret.ts`). The Worker and CLI derive it, so there is no second secret. If you change `TOKEN`, run `cradle gh hook` again for each repo.
- Ticket ID comes from the head branch (`web-1-x` or `user/web-1-x`). If the branch does not match, it comes from the PR title (`WEB-1: ...`).
- `opened` / `reopened`: set `pr`. If status is `backlog` or `todo`, set `doing`.
- `closed` + merged: status `done`, note `merged <url>`.
- Everything else (closed without merge, other events, unknown ticket, no ID): 200 + reason text. The text shows in GitHub's delivery log.
- `cradle gh hook [owner/repo]` creates the hook with `gh api`, or updates it if it exists. Without an argument it uses the current repo.

## Build order

1. ~~`core` + D1 migrations + REST + token auth.~~ Done.
2. ~~CLI.~~ Done.
3. ~~MCP.~~ Done. Connected in Claude Code at user scope.
4. ~~`/gh` webhook + `cradle gh hook`.~~ Done.
5. ~~`/t` read-only view + token login.~~ Done.
6. Later: more users.
