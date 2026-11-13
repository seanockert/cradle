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
src/format.ts  compact text (CLI + MCP), Backlog.md export + parse
src/mcp.ts     MCP server, 4 tools
src/github.ts  PR webhook
src/web.ts     /t read-only HTML + login
src/secret.ts  values derived from TOKEN
src/cli.ts     `cradle` CLI (Bun), calls /api
migrations/    D1 SQL
test/          bun test, pure functions
```

REST and MCP call the same `core` functions. They cannot drift.

## Data (D1)

```sql
projects(key PK, name, description, repos, seq)  -- key: 2-5 uppercase letters, e.g. ABC. description: markdown goal + context
tickets(id PK, project, num, title, status, assignee, branch, parent, pr,
        body, labels, created, updated)          -- id: ABC-123
deps(ticket, blocked_by)
notes(id, ticket, ts, text)                      -- append-only
```

- Project context: `description` holds the goal and context as markdown. Lists show its first non-heading line; getting one project shows all of it plus ticket counts. Save creates (needs name) or updates; `edits` change part of it.
- Project repos: git repo names the project owns (`cradle,cradle-web`), lowercase, max 10. One project per repo, so lookup by repo is exact. Accepts `owner/name` or a git URL and keeps the name. Agents call `project repo=<name>`; the CLI uses the current repo for `new` and `import`.
- Ticket numbers are per project. One D1 batch (a transaction) bumps `projects.seq`, inserts the ticket, its deps and note. A failure rolls back all of it, so numbers never skip or repeat.
- Status: `backlog | todo | doing | done | cancelled`.
- Branch: `abc-123-<title-slug>`, slug max 40 chars, cut at a word. You can override it.
- Labels: one comma-joined column (`bug,ui`), lowercase, max 10, each `[a-z0-9][\w.:/-]` up to 60 chars. Save replaces the list. Filter with `instr`, no index (personal scale). Usual set: `bug`, `feature`, `improvement`, `chore`. The project owns the repos, so tickets have no repo label.
- `parent` gives sub-tickets. `deps` gives blocked-by. The software shows both but does not apply rules to them.
- Search: `LIKE` on title + body. Fast enough at personal scale. No FTS5.
- Edits: last write wins (v1).
- Cleanup: a daily cron (03:00 UTC) deletes cancelled tickets not updated for 30 days, with their notes and deps. Sub-tickets lose the parent. Done tickets stay. Numbers are not used again.

## Auth

- v1: one bearer token, kept as a Worker secret. The CLI reads it from `~/.config/cradle/config.json`.
- `/t`: paste TOKEN at `/t/login` once. Sets an HttpOnly cookie (30 days, path `/t`) whose value is derived from TOKEN. Changing TOKEN logs out. No Cloudflare Access, so no Zero Trust plan.
- `/gh`: GitHub HMAC signature. Secret derived from `TOKEN`.
- Later: `users` table, one token per user. `assignee` is already a handle.

## MCP (done)

`src/mcp.ts`. Stateless Streamable HTTP, JSON responses, new server per request, no Durable Objects. Auth: key in URL (`/mcp/<key>`, derived from TOKEN, MCP only) or bearer TOKEN on `/mcp`. Fails with 403, not 401, so clients do not start OAuth. `cradle mcp add` sets up Claude Code; `cradle mcp` prints the URL + config. Tool definitions total about 3 KB (about 750 tokens).

| Tool | Does | Returns |
|---|---|---|
| `list` | Filter by project, status, assignee, label or text. Done is hidden by default. | `ABC-123 [todo] Fix auth redirect #bug @sean` per line |
| `get` | One ticket. `notes:true` adds the log. | Markdown + frontmatter: status, assignee, branch, pr, parent, blocked_by |
| `save` | Create or update. Takes an array. Edits body with `edits: [{old,new}]`. `note` appends to the log. | IDs only |
| `project` | No args: list. `repo` or `key`: goal, context, repos, ticket counts. `key` + fields: create or update; `repos` sets the repos, `edits` change part of the context. | Lines, markdown, or key |

Rules: tool descriptions under 30 words. Lists never include body. Default limit 50; a cut-off list ends with a `(more: ...)` line. Timestamps to the minute.

Server `instructions` (sent once when the agent connects, about 900 bytes). Full text in `src/mcp.ts`. They cover:

- Find the project with `project repo=<git repo name>`. Read its goal and context before work. Keep tickets aligned with it. If no project owns the repo, ask the user.
- Ticket writing standard (below). Labels: one type.
- Work flow: get, check against main, branch, status doing, notes.
- Before a PR: run Verify, tick each Done when item. Then save `pr`.

## Ticket writing standard

Opinionated, so any agent can pick up a ticket and check its own work with no other context.

- Title: imperative, one outcome.
- Body: `## Goal` (why, 1-3 sentences, linked to the project goal), `## Done when` (`- [ ]` items, each testable), `## Verify` (commands or steps that prove each item). `## Context` only if needed.
- Short sentences, one instruction each, no filler (ASD-STE100 style).
- Project context: `## Goal`, `## Constraints`, `## Not in scope`.
- Not enforced. A create without the three sections still saves, but MCP `save` and `cradle new` warn with the missing ones. `cradle new -e` opens the template (`TEMPLATE` in `src/format.ts`).

## CLI (`cradle`) (done)

Bun script, linked with `bun link`. Run `cradle --help` for usage.

```
cradle ls [-p ABC] [-s todo,doing] [-a name] [-l label] [-q text] [--parent ID] [--all]
cradle show ID [-n]
cradle new "Title" [-p ABC] [-s status] [-a name] [-l bug] [-b body | -f file|- | -e] [--parent ID] [--blocked-by ID,ID]
cradle edit ID [-t title] [-s status] [-a name] [-l labels] [--pr url] [--parent ID] [--blocked-by ID,ID] [-b body | -f file|-]
cradle edit ID -e             # $EDITOR, saves changed fields only
cradle mv ID [ID...] STATUS
cradle note ID "text"
cradle start ID               # status=doing + git checkout (creates branch if needed)
cradle branch ID
cradle import FILE|- [-p ABC] [-s status] [--split]
cradle export ID [ID...] [-o DIR|FILE.md|-]
cradle export -p ABC [--all] [-o DIR]
cradle project [KEY|.]        # list, or one project's goal + context. . = this git repo's project
cradle project new KEY "Name" [-r repo,repo] [-b context | -f file|-]
cradle project edit KEY [-t name] [-r repo,repo] [-b context | -f file|-] [-e]
cradle mcp [add]              # MCP URL + config, or add to Claude Code
cradle gh hook [owner/repo]   # PR opened -> doing, merged -> done
cradle login [URL] [TOKEN]    # checks and writes ~/.config/cradle/config.json (or use CRADLE_URL, CRADLE_TOKEN)
--json                        # compact JSON
```

- Default project for `new` and `import`: `-p`, then `CRADLE_PROJECT`, then the project that owns the current git repo (origin remote name, else the repo folder name).
- Import: frontmatter `title`, else H1, else the file name. `--split` makes each `##` section a sub-ticket under one parent. Reads cradle and Backlog.md keys (`dependencies`, `parent_task_id`, `To Do`/`In Progress` statuses). If the file `id` is from another project, links to other tickets are dropped with a warning. `## Notes` items (`- <time> <text>`) become one note each with their own time. REST create takes them as `notes: [{ts, text}]`; the MCP schema does not.
- Export: Backlog.md task format. YAML frontmatter (`id, title, status, assignee[], labels[], created_date, updated_date, dependencies, parent_task_id`, plus `branch`, `pr`), then the body, then `## Notes`. File name `abc-1 - Title.md`. The web view serves the same file at `/t/ABC-1.md`.
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
