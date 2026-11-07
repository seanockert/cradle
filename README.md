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

Endpoint: `https://cradle.<you>.workers.dev/mcp`, header `Authorization: Bearer <token>`.

```sh
claude mcp add --scope user --transport http cradle https://cradle.<you>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Other agents: add an HTTP (Streamable HTTP) MCP server with the same URL and header.
