# Bot uploads and artifacts in S3

This is a one-time implementation/backfill from Jim's Nightly Improvements item,
not a recurring migration. Local workspaces and file copies are retained. The
catalog contains registered files only, including archived/deleted bot identities
whose registrations and files still exist. No folder sync, backups or eviction.

## Release order (Dwight owns integration, publication and idle backend activation)

1. Publish the cloud API/shared signing/schema commit with both browser flags
   unset. Existing Todo uploads keep their bucket, signing region, URL lifetimes,
   size limits and POST policies. Schema migrations add owner-scoped bot identities,
   file registrations and a stable ready-file paging sequence.
2. Privately provision **a separate** `BOTS_STORAGE_SERVICE_SECRET` on the cloud
   app and bridge's existing owner-only environment file. Do not reuse the relay,
   notification, owner-session or bucket credential. Bind `BOTS_MACHINE_ID` to the
   existing machine. Do not put this credential in bot profiles, prompts or frontend
   bundles. This does not require new bucket permissions. Ask Dawar before expanding
   provider/account access if the existing credential cannot perform a required op.
3. Verify the actual configured provider: signed POST to staging, signed GET/HEAD,
   conditional CopyObject and streaming SHA-256 verification of the copied original.
   Test zero-byte and binary files. A prepare/finalize retry uses the original ID;
   an acknowledged ready original is never overwritten. An uncertain copy/receipt
   is reconciled by re-reading the same final object. Staging remains disposable.
4. Integrate bridge/tools, then activate **only when all native work is idle** using
   the repository's normal handoff. Do not restart active bot work for this rollout.
   `bots_download_attachment` is also exposed through the authenticated bot MCP for
   existing threads which cannot replace their persisted native tool catalog.
5. Inventory again and backfill all ready registrations. Load the private bridge
   environment without printing it, then run `node bot-bridge/storage-migrate.mjs`
   for an inventory, `--apply` to backfill, and `--verify-cloud` for an independent
   second read of every cloud copy. Every attempt retains the original attachment
   ID; failures are reported individually. The private
   `storage-migration-checkpoint.json` records progress, never signed URLs/paths.
   No original files or records are removed. Re-run inventory to reconcile files
   registered during the backfill; do not infer completion from an initial count.
6. Confirm CORS for `https://work.dawar.ca` using real browser POST and fresh signed
   GET responses. The initial 2026-10-01 probe of the existing Spaces endpoint
   returned 403/no allow-origin headers for OPTIONS POST and GET; this is unresolved.
   Keep `BOTS_STORAGE_ENABLED` unset until this and provider integrity are verified.
   Change CORS through the existing authorized provider configuration only; obtain
   Dawar's approval if a credential/access expansion is required.
7. Integrate browser transfers and then enable `BOTS_STORAGE_ENABLED=1`. Only set
   `BOTS_STORAGE_CATALOG_READY=1` after ready registrations are reconciled and
   backfill verified. Browser drafts and file bytes remain in their existing
   IndexedDB store. Pending transfers retry their original IDs. Account changes
   revoke access without deleting drafts. Cloud downloads/catalog need the owner
   session but never a relay or running bot machine.
8. Verify the live acceptance flows: browser upload -> bridge local read -> bot
   publication -> browser download, SHA-256 identical; interrupted/expired transfers;
   lost acknowledgement/restart; unauthorized and cross-bot IDs; explicit peer grant;
   archived gallery filters, previews and old conversation links/queued file IDs.
   Simulate unavailable bridge at the client boundary rather than stopping live
   bot work. Confirm cloud list/download still succeed with zero bridge requests.

## Compatibility and rollback

`bot-artifact:<original ID>` links and all existing upload IDs remain unchanged.
Local SQLite owns execution/provenance/local path mappings; D1 owns cloud file and
bot metadata. Browser/server tools never accept arbitrary object keys. Peer sharing
creates the recipient's own registration and materializes a verified local copy.

Old browser chunk transfers and local reads stay available. A new browser falls
back to legacy reads only for a missing/unmigrated registration; checksum or access
failures do not silently downgrade. Files which fail backfill keep their local read
path. Optional image/PDF thumbnails are mirrored asynchronously and excluded from
the original-file gallery; rendering/upload failure never blocks the original.

To roll back direct upload/gallery routing, unset both browser flags. Keep D1 rows,
objects and local copies. Do not roll back the bridge before materializing cloud-only
browser uploads into their bots' uploads directories; reconcile every retained draft,
queue and conversation attachment ID first. New input is materialized and checked
before any Codex submission. No bucket secret is installed on the bot machine.

## Verification references

- [DigitalOcean Spaces S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/)
- [DigitalOcean SDK signing configuration](https://docs.digitalocean.com/products/spaces/reference/aws-sdks/)
- [Cloudflare streaming Node crypto support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)

Synthetic functional tests verify SigV4 POST/header/query signatures independently,
conditional copy, byte roundtrip, idempotency, authentication/owner/bot scopes,
explicit peer grants, immutable local installation and failures. These are evidence
for implementation behavior, not proof of a live provider deployment or migration.
