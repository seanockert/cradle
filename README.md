# Cradle

Headless ticket tracker for AI agents. Hono + Cloudflare Workers + D1. See `PLAN.md`.

## Local

```sh
bun install
bun run db:local          # apply migrations to local D1
bun run dev               # http://localhost:8787, token in .dev.vars (TOKEN=dev)
bun link                  # puts `cradle` on PATH
CRADLE_URL=http://localhost:8787 CRADLE_TOKEN=dev cradle project
```

## Deploy

```sh
bunx wrangler d1 create cradle      # copy database_id into wrangler.jsonc
bun run db:remote
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

PR from branch `web-1-...` opened: ticket moves to `doing` and gets the PR link. Merged: `done`.

## Web view

`https://cradle.<you>.workers.dev/t` lists open tickets. `/t/WEB-1` shows one. Log in once with your token.
