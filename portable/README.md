# Portable DawarTodo

This is the staging implementation of the approved portable hub and unified
agent migration. Existing Cloudflare production and installed agents continue
to serve until the exact-source migration and activation gates are satisfied.
It is not a completed migration or a supported active-turn restart.

## Roles

The hub owns human authentication, application SQLite, global logical control
and durable delivery. Agents own local Codex stdio, native workspaces/history,
admission and durable native receipts. `both` installs these same two services
on the central machine; it does not create a special local-only agent path.

Node 24 is required. `npm run portable:build` builds a separate Next.js standalone
target and gateway. `npm run build` retains the existing Vinext/Cloudflare target.
Configuration is an absolute owner-only JSON file (version 1). Local services
listen on loopback. Service definitions are installed disabled; installation
never bypasses the original production restart or writer-authority gates.

## Enrollment

Run `node portable/cli.mjs key --data PATH` on the agent. Confirm the displayed
Ed25519 fingerprint through the authenticated hub owner enrollment API, which issues a
five-minute grant. Provision its token in a private local file and run
`node portable/cli.mjs pair --config PATH --token-file PATH`. The node proves
possession with a fresh challenge before the grant is consumed. Native Codex
credentials remain local and are not included in enrollment or hub backups.

The node journal persists incoming commands before acknowledgment. Operation
bindings include original ID, payload fingerprint, owner, bot, node and
placement epoch. Unknown native outcomes are retained; transport retries do
not authorize native replay. Revocation is checked on each live node frame.

## Current unfinished acceptance

Logical queue/schedule integration, full agent runtime/browser routing, local
attachment adapters, voice/provider consolidation, staged data migration,
owner deployment inputs and genuine Mac/device/native acceptance are tracked
in the migration checkpoint. A protocol module or successful build does not
establish production completion.

The registered-file streaming and restic snapshot/isolated-restore modules are
implemented. Disposable protocol and real encrypted local-repository restore
observations are retained in the private migration evidence. This does not
establish an operational S3 backup, scheduled backup, working Mac node or
production write freeze. Those remain required outcomes of the active Goal.

Node agent admission is deliberately limited to assigned explicit text turns
until the remaining hub-owned queue/schedule/provisioning adapters are wired.
Unsupported controls fail closed rather than creating a second scheduler.
Next.js and Sharp security updates are validated before this Node target may
be exposed publicly. The Cloudflare production route remains unchanged.
