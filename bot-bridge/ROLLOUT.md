# Rollout status — 2026-09-25

## Completed locally

- Source reconciled with the existing Site before editing; feature branch `codex/bots`.
- Codex 0.156.1 protocol bindings generated; the runtime enforces that version.
- Bots UI, owner ticket endpoint, separate relay, runtime, schedules, attachments, request forms and notification outbox implemented.
- `dawar-todo-bots.service` installed, enabled, and running as `dawar`; user lingering enabled.
- Persistent state at `/home/dawar/.local/share/dawar-todo-bots/state.sqlite` and workspaces at `/home/dawar/bots`.
- Local relay and browser exercised together. Desktop and 390 × 844 mobile layouts checked.
- Dedicated `Bots validation` task created, streamed, asked a native question, accepted an answer from another connection, transferred an attachment, ran a harmless scheduled prompt, accepted steering and Stop, and retained its task identity after a service restart. Test bot archived afterward.
- 97 application tests and 14 Bots tests passed; production build, TypeScript checks and relay deployment dry run passed.
- Owner/machine IDs and signing/notification secrets prepared in Sites runtime settings. They are not applied to production until a Site version is deployed.

## Still required for production

1. Authenticate Wrangler on this VM (`npx wrangler login`), then deploy and configure the relay using the steps in README.md. Wrangler currently reports that it is not authenticated.
2. Restore the Sites plugin publishing helpers. The previously available `sites/0.1.71/scripts/site-workflow.mjs` and companion files disappeared from the plugin cache during this task. A filesystem search and plugin-directory search did not recover them. Publishing through the established Sites workflow is therefore pending.
3. Replace the VM service's local validation relay/Site URLs with the real deployed WSS relay and `https://work.dawar.ca`, set the Site's `BOTS_RELAY_URL`, restart the service and publish the saved Site version with migration 0030.
4. Run the final production owner-auth, two-device and Web Push delivery check on an owner device with notifications enabled. Delivery deduplication is covered locally; actual OS notification delivery has not been verified.

The service is currently connected to a **local validation relay**, not a deployed public relay. The existing production Site has not been replaced. No production rollout is claimed.
