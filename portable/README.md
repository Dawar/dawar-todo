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

The mailbox cursor is persisted on the node. A positive original native
receipt can recover a lost received ACK without resubmitting its input.
Stop stores its hub admission fence in the command transaction; its native
interrupt remains admissible under that fence, while further starts wait.
Frame processing does not wait for slow native acknowledgment. Offline Stop
remains pending until the assigned node returns its actual receipt.

Hub events use a global persisted sequence, independent of each node's native
sequence. Duplicate packets retain the original sequence and are not shown
again. Owner-scoped replay and bounded concurrent snapshots preserve the
existing browser representations. Only observed common capabilities are
advertised; platform capability limits still apply.

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
production write freeze. The latest direct human amendment defers backups for now; retain these modules and evidence for later enablement. Genuine Mac/production acceptance remains unfinished.

Node agent admission is deliberately limited to assigned explicit text turns
until the remaining hub-owned queue/schedule/provisioning adapters are wired.
Unsupported controls fail closed rather than creating a second scheduler.
Next.js and Sharp security updates are validated before this Node target may
be exposed publicly. The Cloudflare production route remains unchanged.

## Authentication and Mac delivery amendment

Use a dedicated Auth0 Regular Web application with server-side authorization code plus PKCE, an exact issuer, and an explicit stable-subject binding to the retained owner. The client secret stays in an owner-only file, never a frontend bundle. `work.dawar.ca` remains the approved public origin. The Settings machine installer downloads only code and integrity manifests; keys and Codex credentials remain local. Pairing grants expire after five minutes. Installer/service setup does not itself start a native turn.

The portable session uses an HttpOnly session cookie and a separate Secure,
SameSite=Strict CSRF cookie. First-party request factories send that CSRF token;
the gateway requires both its exact session binding and the approved Origin.
The original Cloudflare build keeps its existing authentication behavior.

Run `node portable/agent-package.mjs` after the exact clean portable build to
produce the Settings ZIP download. It includes a platform installer for
Node24 and a pinned, integrity-locked local Codex runtime. The installer copies
only manifest-listed files into a new immutable release, verifies an existing
release without reinstalling dependencies, and never starts a service or bot.
Local credentials and workspaces are not bundled or copied to the hub.

An enrollment timeout retains the original grant/key identity. The installer
first queries signed, fresh, read-only status for that SAME grant and key. A
positive accepted receipt can be recovered even after its grant expires; an
expired unconsumed grant is not renewed. Revocation, changed keys/hello and
foreign identities fail closed. Native execution still requires an explicit
reviewed activation receipt and an approved bot placement.
