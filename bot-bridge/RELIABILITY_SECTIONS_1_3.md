# Reliability sections 1 and 3 — status (October 15, 2026)

Source: TONIGHT_TEAM_WORK_INVENTORY_20261014.md §1 "Restore dependable Send, blast and Queue" and
§3 "Make conversation and account recovery predictable". Source-ready only: not installed, not
device-accepted. Tests: `tests/portable-send-reliability.test.mjs` (hub + bundled agent harness,
`tests/helpers/portable-harness.mjs`), `tests/bot-chronology.test.mjs`,
`tests/bot-client-recovery.test.mjs`, `tests/bot-draft-cross-device.test.mjs`,
`tests/session-availability.test.mjs`.

## Section 1

| Bullet | Status | Evidence |
| --- | --- | --- |
| Reuse pre-admission fix a4c0b5d | already present | in codex/bots; test "proved pre-native deferral … retries itself once" |
| Durable save independent of execution | already present | queue.add while busy; Send/Queue while node offline |
| One submission path, original identity | already present | queue/schedule/burst client IDs stable across a deferral retry |
| Proved pre-native refusal = not started | fixed | burst native-read failure and hub team-read timeout now defer, not fail (Sian) |
| Reconcile lost completion | fixed | agent recovery runs the active-turn watchdog; queue progresses with no new message |
| Lost acknowledgement / reconnect | already present | dropped receipt reconciled on reconnect, one turn/start |
| Duplicate events | already present | duplicate turn/completed + receipts dispatch next message once |
| One activity definition | fixed | old nonblocking question no longer blocks admission (Doc) |
| Metadata off the start path | fixed | team reference prefetched before prepare and reused by the send |
| Settings saves off the critical path | blocked | `bots.update` shares the per-bot execution lock; send paths save stale bot objects, so lifting the lock needs field-level patches first |
| Stop authoritative | already present | stopped bot does not drain its queue after a missed completion |

## Section 3

| Bullet | Status | Evidence |
| --- | --- | --- |
| Canonical chronology across cached/live/history | fixed | UUIDv7 native turn start; missed event + late page, cold reopen, bot switch tests |
| Final/commentary, no private reasoning | already present | unchanged conversationEntries filters |
| Prompt catch-up on reopen/reconnect; plan repair | already present | plan-only turn recovered from history keeps identity and place |
| 3 s foreground deadline / false disconnects | fixed | slow pong keeps socket and reads; dead socket replaced within 10 s |
| Cross-device drafts | already present | two devices via real draft CAS, through a 503 outage |
| Monotonic read markers | already present | replayed/stale events and cold snapshot do not unread a read bot |
| Attachment retry after reconnection | already present | existing stable upload ID tests; several attachment suites fail at baseline (unchanged) |
| Session expiry vs connectivity vs native auth | fixed | storage failure in session check is 503, not 401; gateway 502/503/504 keep owner, drafts, uploads |
| Native auth / external-writer recovery | already present, no new test | primary-work-view recovery kinds unchanged |
| Mobile-width order | not covered here | ordering is width-independent; needs the browser harness |
