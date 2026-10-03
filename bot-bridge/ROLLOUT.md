# Rollout status — 2026-09-25

## Production deployment

- Bots page: https://work.dawar.ca/bots
- Sites publication: version **116**, deployment `appgdep_6ab5eee03a20819188df8de6e8789baa`, status **succeeded**.
- Published source: `a78d56b87d227af6c256addf75d6e7b0b11edc91` (later rollout-documentation commits do not change that release).
- Canonical Sites publication: https://dawar-todo.dawar185924.chatgpt.site
- Public relay: https://dawar-todo-bots-relay.dawar.workers.dev; WebSocket endpoint `/connect`.
- Relay machine/signing secrets configured; Site environment revision **22** applied, including the production relay URL, owner identity and notification/signing secrets.
- `dawar-todo-bots.service` is enabled and running as `dawar`, with user lingering enabled. Its URLs now point to the production relay and `https://work.dawar.ca`.
- Health reports `ready: true` and `relayConnected: true` against the public relay.
- Persistent state remains at `/home/dawar/.local/share/dawar-todo-bots/state.sqlite`; workspaces remain at `/home/dawar/bots`.

## Validation completed

- 97 application tests and 14 Bots tests passed; production build, TypeScript checks and relay deployment dry run passed.
- Desktop and 390 × 844 mobile layouts checked locally.
- Dedicated validation bot: persistent native task creation, streaming, native question with response from a second connection, chunked attachment round-trip, harmless scheduled run, dynamic schedule tool, steering/Stop, archive/restore, and service restart retaining the same task. Validation bot archived after checks.
- Two independent authenticated connections to the **public** relay retrieved a ready VM snapshot and the same native conversation history. This used test tickets signed with the configured bridge key; it does not substitute for the browser sign-in check below.
- Production `/api/bots/session` returns **401** without authentication and **403** for ordinary bearer access.
- Production notification ingestion returned **202** for an authenticated setup event and its retry using the same deduplication ID. OS notification delivery has not been verified.

## Publishing notes

Wrangler credentials are exported by the user's interactive shell. Deploy commands ran with `bash -ic` so those credentials were available, without copying or displaying the token.

The old Sites helper files remain absent from the plugin cache. Publication completed through the connected Sites API: obtain a temporary source credential, verify and fast-forward the Site source branch to the exact release commit, package the existing build with root `.openai/` metadata plus `dist/server/index.js` and client assets, save version 116, then deploy it. No temporary source token was persisted. No credentials or VM state are in the archive or Git repository.

## Remaining user-session verification

The in-app production browser reached Cloudflare human verification before ChatGPT sign-in. Complete that sign-in at https://work.dawar.ca/bots to verify the owner session and conversation UI in production. An owner device with notifications enabled is also needed to confirm actual Web Push delivery. These checks remain pending; the Site, public relay and VM connection are deployed.
