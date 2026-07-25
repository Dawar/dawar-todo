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
