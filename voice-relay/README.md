# Dawar Todo voice relay

This Worker is the public WebSocket media edge for Twilio phone calls. It keeps
all task data, tools, transcripts, and authorization in the Sites application.

Flow:

1. Sites verifies the caller's PIN and gives Twilio a five-minute one-time
   stream token.
2. Twilio connects to this Worker's `/stream` WebSocket endpoint.
3. The relay exchanges that token for an ephemeral OpenAI Realtime credential
   and a server-owned Talk session through the Sites bridge.
4. Audio stays in the relay. Tool calls, finalized transcripts, heartbeats, and
   call completion go through the authenticated Sites bridge.

The relay has no D1 binding and stores no task data or provider API keys.
