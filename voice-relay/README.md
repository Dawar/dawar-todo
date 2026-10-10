# Dawar Todo voice relay

This Worker supports a preferred direct OpenAI SIP path and retains the Twilio
Media Streams path as an immediate rollback. It keeps all task data, tools,
transcripts, and authorization in the Sites application.

Flow:

1. Sites verifies the caller's PIN and gives Twilio a five-minute one-time
   transport token.
2. In direct SIP mode, Twilio dials OpenAI over TLS. OpenAI sends its incoming
   call webhook to `/openai/webhook`, and a Durable Object keeps the
   control-only Realtime sideband alive.
3. Audio flows directly between Twilio and OpenAI. Tool calls, finalized
   transcripts, heartbeats, and call completion use the authenticated Sites
   bridge.
4. In rollback mode, Twilio connects to `/stream` and this Worker relays PCMU
   audio using an ephemeral OpenAI credential minted by Sites.

The relay has no D1 binding and stores no task data. Direct SIP requires an
`OPENAI_API_KEY` Worker secret belonging to `OPENAI_PROJECT_ID`; neither value
is returned to clients or logged.

Before enabling direct SIP:

```bash
npx wrangler secret put OPENAI_API_KEY --config voice-relay/wrangler.jsonc
npm run voice:deploy
```

Configure the OpenAI project webhook to:

```text
https://dawar-todo-voice-relay.dawar.workers.dev/openai/webhook
```

Then set `TWILIO_PHONE_TRANSPORT=sip` in Sites. Keep
`TWILIO_MEDIA_STREAM_URL=wss://dawar-todo-voice-relay.dawar.workers.dev/stream`
configured so setting `TWILIO_PHONE_TRANSPORT=media` immediately rolls back.
# Original voice writer admission during migration

The optional private `VOICE_WRITER_CONTROL` contains `version:1`, the exact
reviewed 40-character `sourceId`, `installationId`, 64-character
`producerSHA256`, a private base64url `credential`, `cutoverId` and `releaseId`.
The three operation IDs are distinct and fixed for the installation. With no
configuration, the existing Cloudflare and portable voice behavior is retained.
The new `VoiceMigrationCoordinator` binding is a durable serialized ledger;
declaring it does not enable control or install a journal.

`POST /api/migration/voice/control` accepts only that separate private bearer,
JSON, no browser Origin, and one fixed action: `install`, `read`, `receipt`,
`drain` with `expiresAt`, or `release` with the exact generation. Requests are
bounded to 4 KiB/64 chunks and 4.5 seconds. The control route cannot admit work,
select another operation ID, clear uncertain rows or run provider calls.

When enabled, the actual Worker admits HTTP, scheduled and streaming work
persistently before effects. SIP starts receive a child admission from their
already-admitted webhook, so a drain does not reject the continuation of that
same accepted call. New independent starts are held. The same scope tracks
outbound HTTP response consumption, server/provider sockets, nested background
factories and both tool queues. Calls settle only after their end path, closed
sockets and all tracked work. Network errors, cancelled bodies and lost
admission/settlement acknowledgments retain blocking originals; no automatic
retry or alternative call is created. A new SIP object instance cannot turn a
retained original call/admission into a new start.

A drain lasts at most 15 minutes and reports `trackedIdle` only before its
deadline with zero active and unknown rows. Expiry invalidates its proof and
does not silently reopen admission. Only the original exact release restores
new starts; receipts and unknown rows remain. At most 1,024 unfinished and
10,000 total admissions are retained in this temporary ledger.

**This is not complete legacy-call coverage.** Its status always reports
`legacyCallCoverageEstablished:false` and
`fullProductionWriterFreezeEstablished:false`. Pre-installation streams,
provider callbacks, old SIP instances and external effects must be reconciled
from their actual original identities before voice qualifies the combined
production freeze. Do not deploy/enable this path over active old calls or
infer their absence from the new empty ledger. Preparing or validating this
source performs no production installation, provider call or cutover.
