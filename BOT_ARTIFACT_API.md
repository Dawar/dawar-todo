# Bot artifact data/delivery contract

Backend change based on `a5f68a92dc45a4de1c1c8083e7e053d8a4759694`. Integrate onto the current main (including upload-only v137 / `1216bbcb7b36e6a8f24aa53727ad2a34d88addfc`); do not replace that base. This change requires a coordinated bridge reload and frontend integration, not relay publication. No worker reload/deployment was performed.

## UI integration

Authoritative types: `BotArtifact`, `BotArtifactQuery`, `BotArtifactPage`, `BotArtifactPreview` in `lib/bots-types.ts`; methods in `lib/bots-operations.ts`. Existing `BotsClient.rpc` and `download` work without client changes. Capture `owner` at the start of every request and pass it in RPC options; discard late UI results after owner/bot/filter changes. Cache thumbnail URLs/metadata by **owner + botId + attachment ID + preview.version** and revoke them on owner change/sign-out. No persistent browser artifact cache is introduced here.

```ts
const page = await client.rpc<BotArtifactPage>(
  "artifacts.list", botId /* undefined = global */, {
    limit: 36, cursor: null, search: "", type: "all",
    direction: "all", sort: "newest",
  }, undefined, { owner },
);
const preview = await client.rpc<BotArtifactPreview>(
  "artifacts.preview", item.botId,
  { id: item.id, version: item.preview.version }, undefined, { owner },
);
const original = await client.download(item.botId, item.id, owner);
```

- `artifacts.list` returns `{items, nextCursor}`; limit 1–60, default 36. Search is a literal case-insensitive filename substring (maximum 160 characters). Type: `all | image | pdf | document | audio | video | other`. Direction: `all | input | output`. Sort: `newest | oldest | name`, default newest. Group the default order by creation month in the UI. Dates unknown in legacy records remain `null`; do not invent dates.
- Each item has existing stable `id`, `botId`, `name`, `mimeType`, `size`, `ready`, plus `botName`, `botColor`, `botArchived`, `createdAt`, `direction`, `source` (`upload | published | native`), `kind`, known `provenance` (`threadId`, `turnId`, `itemId`, `operationId`), and `preview: {kind: image | pdf | none, version}`. Unsent uploads already completed on the bridge are included as inputs; provenance can remain empty until a message references them.
- Listing uses SQLite metadata only, with no native history fetch, filesystem access, thumbnail decode or file-body download. Ready input uploads and published outputs are included; pending upload bytes are untouched and omitted. Archived bots remain accessible. No path or signed URL is returned by the library.
- Cursors are opaque, versioned, tied to the bot/filter/sort, and use an insertion ceiling plus ordered key/ID. First library access transactionally adds a metadata-only sequence table and ready-transition triggers, retaining every original record. Its monotonic sequence avoids SQLite row-ID reuse and excludes uploads that finish after the first page. A changed query requires a new cursor. Insertions cannot shift later pages; deletion of an anchor does not invalidate traversal. De-duplicate appended cards by `id`. After indexing or an `attachment` event, refresh from the first page to see newly inserted/backdated files.
- A successful preview is `{status:"ready", version, mimeType:"image/webp", data /*base64*/, width, height}`. An unavailable preview is `{status:"unavailable", version, reason}`. Fetch only visible/near-visible cards, at low concurrency, and keep fallback cards with their real name/type/size. Busy/unavailable is not an empty artifact library. Originals remain separate from derived previews.
- Open/Download uses existing `client.download`, preserving original bytes. Open images/PDFs via a revocable Blob URL when requested; other formats download. Do not embed active HTML/SVG as documents. A large original is loaded only after user action, never just to list cards. Original chunk size remains 256 KiB, file limit 100 MiB.

### Native discovery

`artifacts.index`, with **request botId required**, accepts `{cursor?: string|null}` and returns `{registered, nextCursor, failures: {itemId, reason}[]}`. It reads at most one native 20-turn page, processes at most 40 items per call, and performs no turn/send mutation. Returned `registered` counts recognized/reconciled outputs, including idempotent repeats; it is not a count of newly inserted rows. Identical in-flight scans coalesce, with two distinct scans allowed concurrently.

Use the registered library immediately. A bounded first indexing step can run alongside it when opened; expose continued discovery/retry if `nextCursor` or failures remain. Global discovery iterates the owner's snapshot bots at bounded concurrency. Do not loop through all history before showing the gallery, nor claim a complete native-output inventory while indexing is incomplete. Surface `artifact.issue` events as recoverable registration notices, with indexing retry. New `item/completed` outputs register asynchronously and emit ordinary `attachment` events when available.

## Native output eligibility and provenance

The checked-in Codex 0.156.1 schema has an explicit `imageGeneration` item (`status`, `failure`, `result`, optional `savedPath`). Completed successful results support validated PNG/JPEG/WebP inline base64 or a regular saved file inside the bot's workspace. Structured MCP `resource_link` file URIs and inline `resource.blob` outputs qualify only when their own annotations explicitly include audience `user`. This distinguishes intended delivery from tools returning context for the assistant. Up to six such resources per item and 20 MiB per inline resource are considered.

`bots_publish_artifact` remains the explicit general file/PDF publishing tool. Its native `callId` is now an idempotency key, with known turn/item attribution. Same bot/name/bytes have a stable content-derived ID; separate bots never share an ID or stored copy. Already-registered legacy artifact paths retain their existing IDs when rediscovered. Legacy duplicate records are retained rather than deleting old links/files.

New path publications must resolve to a regular, non-symlink file inside this bot's workspace. Credential/private configuration names and key-file extensions are rejected. Descriptor checks prevent reading another bot through a parent-path symlink. Previously published/copied records remain readable through their existing methods and IDs. If an explicit deliverable currently lives elsewhere, deliberately copy it into this bot's workspace before publishing; automatic discovery does not reach across workspaces or into arbitrary `/tmp` files.

Not auto-published: markdown/local path text, `fileChange`, command output, `imageView`, arbitrary MCP images/resources intended only for the model, remote URLs, file IDs requiring another service, worker-thread outputs belonging to another managed thread, or all files in a working directory. Native `agentMessage` has text, not a generic structured file/PDF attachment field. These unsupported cases remain explicit links or require `bots_publish_artifact`. Missing/invalid native timestamps and provenance are not fabricated. Backfill uses known turn times; live output registration uses its observed creation time.

## Bounds, durability and authorization

- Existing architecture is **single owner per machine**. Site ticket issuance verifies the configured authenticated owner; the old relay authenticates and machine-scopes the connection. It does not forward arbitrary browser owner parameters. Global library access covers that same machine's managed bots. Individual previews/downloads still require the matching `botId`; there is no new public HTTP file URL or multitenant/per-bot ACL claim.
- Publishing makes a durable copy using bounded streaming, checks source stability, fsyncs the copy/directory, then atomically commits the attachment and publication receipt in SQLite. Retrying after a database failure validates and reuses the completed copy. Originals, draft bytes and old records are not deleted. Process death can leave a staged/completed copy before a receipt exists; no destructive orphan cleanup is introduced.
- Auto-registered native output records have a 1 GiB per-bot ceiling. Reaching it reports a recoverable issue and retains source files. Explicit publishing retains the existing 100 MiB per-file policy; this pass does not delete files or impose a new destructive retention policy on uploaded/published originals.
- Thumbnail input ≤20 MiB; raster decoding ≤32 million pixels and first animation frame; output ≤512×512 and ≤128 KiB WebP. SVG is not decoded. PDF rendering uses page one only, at most 512 px, with a 512 MiB address-space limit, five CPU seconds and six-second wall timeout. Each image-decoder subprocess also has a six-second wall timeout, one Sharp thread, no Sharp cache and a 96 MiB JS heap limit. The pixel cap bounds native decoding; the JS heap limit alone is not an OS memory limit.
- One preview job runs at a time per bridge runtime, with at most eight distinct queued requests. Duplicate requests coalesce. Derived in-memory preview cache is bot/runtime-scoped, ≤16 MiB base64 payload and 128 entries, expires successful entries after five minutes and failures after 30 seconds, and stores no disk thumbnails. Cached byte accounting excludes small JS object/key overhead. The gallery stores no original bytes in the history cache.

## Renderer setup and checks

Sharp **0.34.5**, already present in the lockfile, is now an explicit dependency. PDF executable resolution: `BOTS_PDFTOPPM_PATH`, then `~/.local/share/dawar-todo-bots/tools/poppler/bin/pdftoppm`, then `pdftoppm` on PATH. Linux `prlimit` and `/proc/self/fd` are required. The manager provisioned Poppler 25.03.0 privately from pinned Debian packages; package versions/hashes are in the sibling `poppler-25.03.0-deb13u4/manifest.json`. No sudo/package-system changes or credentials are needed by this implementation. Missing/failed decoders return a per-file unavailable result, not fake preview data.

Focused checks:

```sh
node --test bot-bridge/artifacts.test.mjs tests/bot-artifact-old-relay.test.mjs bot-bridge/runtime.test.mjs bot-bridge/history-view.test.mjs tests/bot-relay-envelope-compat.test.mjs
npx tsc --noEmit
```

Fixtures use fresh temporary SQLite/files and synthetic images/PDFs only. Tests exercise actual Sharp/Poppler output, first-page selection, original-byte preservation, transaction recovery, metadata paging, bot isolation, native eligibility/idempotency, and the historical v135 relay implementation (`80a3826`) to the real BotsClient. No live native account, user file, deployed relay, frontend visual flow, actual iPhone/Safari or physical OS-kill verification is claimed. The UI owner must wire and visually verify the gallery and lazy viewer, then the manager runs integrated release checks and coordinates bridge reload.
