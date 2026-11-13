# Cradle

<img width="640" alt="cradle-3" src="https://github.com/user-attachments/assets/6c7de679-1740-4ffd-84e5-b38e499b3630" />

Headless ticket tracker for AI agents. Hono + Cloudflare Workers + D1. See `PLAN.md`.

- [Connect to a cradle server](#connect-to-a-cradle-server): you have a URL and a token.
- [Host your own](#host-your-own): you want a server.
- [Use](#use): CLI commands, labels, projects, the web view.
- [Develop](#develop): you want to change the code.

## Connect to a cradle server

You do not need this repo.

### Agents (MCP)

1. Open `https://<server>/t/connect` and log in with the token.
2. Copy the command for your agent and run it.

For Claude Code, the command is:

```sh
claude mcp add --scope user --transport http cradle https://<server>/mcp/<key>
```

For Claude Desktop and claude.ai, add a custom connector with the same URL.

The `<key>` in the URL opens MCP only, so agents need no headers and no OAuth.
It also gives full access to the tickets, so share it only with people you trust.
A bad or missing key returns 403 with a link to `/t/connect`.
`Authorization: Bearer <token>` on `/mcp` also works.

### CLI

Install [Bun](https://bun.sh), then:

```sh
bun install -g github:seanockert/cradle
cradle login https://<server>    # asks for the token
cradle mcp add                   # optional: connects Claude Code for you
```

If the shell cannot find `cradle`, add `~/.bun/bin` to your `PATH`.
Run `bun install -g github:seanockert/cradle` again to update.

## Host your own

You need a Cloudflare account. The free plan is sufficient.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/seanockert/cradle)

The button makes the Worker and the D1 database, and runs the migrations.
It asks for `TOKEN`.
Make one with `openssl rand -hex 32` and keep it in a password manager.
Then open `https://cradle.<you>.workers.dev/t/connect` and follow [Connect](#connect-to-a-cradle-server).

### Deploy from a clone

```sh
bun install
bunx wrangler d1 create cradle      # copy database_id into wrangler.jsonc
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"     # save this
echo "$TOKEN" | bunx wrangler secret put TOKEN
bun run deploy                      # applies migrations, then deploys
```

Run `bun run deploy` again after you pull new code.

### Lost or leaked token

Set a new token with the same `wrangler secret put` command, or in the Cloudflare dashboard (Worker, Settings, Variables and Secrets).
A new token changes the MCP URL and logs out the web view.
Everyone must connect again from `/t/connect`.

## Use

### GitHub

In each repo (needs `gh` logged in):

```sh
cradle gh hook            # or: cradle gh hook owner/repo
```

PR from branch `web-1-...` opened: ticket moves to `doing`, gets the PR link. Merged: `done`.

### Labels

```sh
cradle new "Crash on login" -l bug
cradle ls -l bug
cradle edit WEB-1 -l feature   # replaces the list; -l '' clears
```

Web view: `/t?label=bug`.

### Writing tickets

Each ticket body has `## Goal`, `## Done when` (testable `- [ ]` items) and `## Verify` (commands or steps). Agents get this rule over MCP and tick the items before they open a PR. Missing sections give a warning, not an error.

```sh
cradle new "Add CSV export" -e       # opens the template in $EDITOR
```

### Project context

Each project has a goal and context (markdown) and owns one or more git repos. Agents find the project from the repo they are in and read it before they work on its tickets, so the work stays aligned. Inside an owned repo, `cradle new` and `cradle import` need no `-p`.

```sh
cradle project new WEB "Website" -r website -f goal.md
cradle project WEB                   # goal, context, repos, ticket counts
cradle project .                     # the project that owns this git repo
cradle project edit WEB -e           # edit in $EDITOR
cradle project edit WEB -r website,website-api   # set its repos
```

### Web view

`https://<server>/t` lists tickets by project and status. Done and cancelled start collapsed. `/t/p/WEB` shows a project's context. `/t/WEB-1` shows one ticket. `/t/connect` shows how to connect agents and the CLI. Log in once with your token (30-day cookie).

### Export

```sh
cradle export WEB-1                  # ./web-1 - Title.md (Backlog.md format)
cradle export -p WEB --all -o tasks  # whole project to a dir
cradle import "tasks/web-1 - Title.md"   # reads cradle and Backlog.md files
```

In the web view: `/t/WEB-1.md`.

## Develop

```sh
bun install
cp .dev.vars.example .dev.vars   # local TOKEN=dev
bun run db:local          # apply migrations to local D1
bun run dev               # http://localhost:8787
bun test
bun link                  # puts this checkout's `cradle` on PATH
cradle login http://localhost:8787 dev
```

## Screenshots

<img width="640" alt="cradle-1" src="https://github.com/user-attachments/assets/55c08326-7e46-4b78-852d-daab80c49322" />

<img width="640" alt="cradle-2" src="https://github.com/user-attachments/assets/508f6c77-6768-4abf-9f3c-09d80e7423dd" />

