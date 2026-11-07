# Cradle

Headless ticket tracker for AI agents. Hono + Cloudflare Workers + D1. See `PLAN.md`.

## Local

```sh
bun install
bun run db:local          # apply migrations to local D1
bun run dev               # http://localhost:8787, token in .dev.vars (TOKEN=dev)
bun test
bun link                  # puts `cradle` on PATH
CRADLE_URL=http://localhost:8787 CRADLE_TOKEN=dev cradle project
```

## Deploy

```sh
bunx wrangler d1 create cradle      # copy database_id into wrangler.jsonc
bun run db:remote                   # run again after pulling new migrations
openssl rand -hex 32 | bunx wrangler secret put TOKEN
bun run deploy
cradle config https://cradle.<you>.workers.dev <token>
```

## MCP

```sh
cradle mcp add    # Claude Code, all projects
cradle mcp        # URL + JSON config for other agents
```

The URL has a key (`/mcp/<key>`), so agents need no headers and no OAuth. The key only opens MCP. `Authorization: Bearer <token>` on `/mcp` also works. Bad or missing key returns 403 with a message.

## GitHub

In each repo (needs `gh` logged in):

```sh
cradle gh hook            # or: cradle gh hook owner/repo
```

PR from branch `web-1-...` opened: ticket moves to `doing`, gets the PR link and the label `repo:<name>`. Merged: `done`.

## Labels

```sh
cradle new "Crash on login" -l bug,repo:shop
cradle ls -l bug
cradle edit WEB-1 -l feature   # replaces the list; -l '' clears
```

Web view: `/t?label=bug`.

## Writing tickets

Each ticket body has `## Goal`, `## Done when` (testable `- [ ]` items) and `## Verify` (commands or steps). Agents get this rule over MCP and tick the items before they open a PR. Missing sections give a warning, not an error.

```sh
cradle new "Add CSV export" -e       # opens the template in $EDITOR
```

## Project context

Each project has a goal and context (markdown) and owns one or more git repos. Agents find the project from the repo they are in and read it before they work on its tickets, so the work stays aligned. Inside an owned repo, `cradle new` and `cradle import` need no `-p`.

```sh
cradle project new WEB "Website" -r website -f goal.md
cradle project WEB                   # goal, context, repos, ticket counts
cradle project .                     # the project that owns this git repo
cradle project edit WEB -e           # edit in $EDITOR
cradle project edit WEB -r website,website-api   # set its repos
```

## Web view

`https://cradle.<you>.workers.dev/t` lists open tickets. `/t/p/WEB` shows a project's context. `/t/WEB-1` shows one ticket. Log in once with your token (30-day cookie). To copy the token:

```sh
jq -r .token ~/.config/cradle/config.json | pbcopy
```

## Export

```sh
cradle export WEB-1                  # ./web-1 - Title.md (Backlog.md format)
cradle export -p WEB --all -o tasks  # whole project to a dir
cradle import "tasks/web-1 - Title.md"   # reads cradle and Backlog.md files
```

In the web view: `/t/WEB-1.md`.
