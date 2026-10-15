# DawarTodo Agent.app (macOS menu bar agent)

A small native menu bar app that installs and supervises the existing portable
execution agent on a Mac, so the owner's Apple M3 Max can act as an execution
node for work.dawar.ca. It reuses the existing agent, node enrollment, local
Codex app-server and hub routing. It is not a chat UI.

## Where this stands

| Stage | State |
| --- | --- |
| Prepared (sources, build script, Linux tests) | **Done** on branch `claude/mac-menubar-agent` |
| Built (`.app` produced) | **Not done.** Needs a Mac with Xcode/Swift. No Mac toolchain exists on the Linux host. |
| Signed (Developer ID) / notarized | **Not done.** Needs the owner's Developer ID identity and a notary profile. |
| Published (release record + archive on the hub) | **Not done**, on purpose. Publishing is the owner's decision. |
| Hub update routes deployed | **Not done.** The routes are in `portable/gateway.mjs` on this branch only. |
| Installed / accepted on the owner's Mac | **Not done.** See [Physical Mac acceptance](#physical-mac-acceptance). |

Nothing here was run on a Mac. A Linux test passing is **not** Mac acceptance.

## 1. Installer runtime fix (done first)

The pinned `@openai/codex` 0.162.1 platform packages describe their own launch
layout in `vendor/<target>/codex-package.json` (`"entrypoint": "bin/codex"`).
The old `setup.mjs` guessed `vendor/<target>/codex/codex`, which does not exist
in the integrity-verified darwin-arm64 archive. That is why the owner's Mac
install stopped before enrollment.

- `portable/codex-runtime.mjs` reads `codex-package.json`, checks layout
  version, target, version and that the entrypoint, resources and PATH
  directories stay inside the vendor directory, and that the entrypoint is an
  executable regular file.
- On failure it reports the OS error code, exit status, signal and bounded
  stdout/stderr with tokens redacted (`RuntimeLaunchError.diagnostics`).
  `setup.mjs` prints these, then says nothing was enrolled, configured or started.
- `tests/mac-agent-runtime.test.mjs` checks the resolver against the real
  pinned archive (SHA-512 matches the lock) when it is on this host, and
  confirms its `bin/codex` is an arm64 Mach-O. The binary is never executed.

## 2. How it fits together

```
DawarTodo Agent.app/Contents
  MacOS/DawarTodoAgent          Swift menu bar shell (AppKit, Sparkle, SMAppService)
  Frameworks/Sparkle.framework
  Resources/
    node/bin/node               pinned Node 24.21.0 darwin-arm64 (+ LICENSE)
    codex/vendor/aarch64-apple-darwin/   @openai/codex 0.162.1 platform package
    agent/                      exact agent download (dist/agent-downloads/…) + node_modules
      portable/mac-agent/cli.mjs   controller the Swift app runs
    licenses/third-party.json
    app-release.json            version, agent source, runtime, hashes
    bundle-manifest.json        every file: bytes, sha256, exec bit, Mach-O archs
    release-public-key.pem      verifies owner-signed update records
```

The Swift app is a thin shell. It runs
`Resources/node/bin/node Resources/agent/portable/mac-agent/cli.mjs <command>`,
which prints one JSON object. All install, pairing, launchd, update and
rollback logic is in Node (`portable/mac-agent/controller.mjs`), so it is
tested on Linux.

The agent itself runs as a **launchd user agent** (`ca.dawar.todo.agent`), not
inside the app. Quitting or updating the app does not stop bots.

Persistent files stay outside the replaceable app:

```
~/Library/Application Support/DawarTodo/
  agent/        node-key.pem, config.json, node-enrollment.json, activation.json,
                activations/<source>.json, status.json, native-control.sqlite, …
  bots/         workspaces
  releases/<source>/        immutable agent releases (previous one kept for rollback)
  runtime/node-v24.21.0-darwin-arm64/, runtime/codex-0.162.1-aarch64-apple-darwin/
  updates/<build>/          downloaded, verified app archives + local appcast
  mac-agent.json            controller state (current/previous/staged, consent, health)
~/Library/Logs/DawarTodo/agent.log, agent.err.log   (rotated at 10 MB)
~/Library/LaunchAgents/ca.dawar.todo.agent.plist
```

## 3. Build (unsigned) on a Mac

Requirements: Apple Silicon Mac, macOS 13 or later, Xcode 15+ or the Command
Line Tools (`xcode-select --install`), network access to nodejs.org, npm and
GitHub (Sparkle via SwiftPM).

1. Produce the exact agent download from a clean checkout. This step is
   platform-independent JavaScript and can run on the Linux host:

   ```bash
   npm run portable:build && node portable/agent-package.mjs
   ```

   It prints the `dist/agent-downloads/dawartodo-agent-<sha12>/` directory.
   Copy that directory (and this repository) to the Mac.

2. On the Mac, from the repository root:

   ```bash
   mac-agent/build-app.sh --version 1.0.0 --build 1 --agent-download dist/agent-downloads/dawartodo-agent-<sha12>
   ```

   The script downloads the pinned Node tarball (the hash check is in
   `bundle.mjs`), runs `npm ci --ignore-scripts --no-bin-links --omit=dev`
   for the reviewed lock, stages Resources, refuses any bundled Mach-O that is
   not arm64, ad-hoc signs every Mach-O, re-seals the hashes after signing,
   builds the Swift target, assembles `build/mac-agent/DawarTodo Agent.app` and
   zips it. It uploads nothing.

   Add `--release-public-key release-public.pem` and
   `--sparkle-public-key <base64>` for a build that can take updates.

3. To open an ad-hoc signed build, right-click → Open, or
   `xattr -dr com.apple.quarantine "build/mac-agent/DawarTodo Agent.app"`.
   This is for local testing only.

## 4. First run

1. **Install** runs on every launch. It verifies every bundled file against
   `bundle-manifest.json` and copies Node, Codex and the agent release into
   Application Support. It writes `config.json` only if none exists, with
   `agent.statusFile` set. An existing release is never switched here.
2. **Pair This Mac…** shows the node fingerprint. In work.dawar.ca → Settings →
   Execution machines, confirm it and download the five-minute pairing file,
   then choose that file. This is the existing enrollment
   (`agent-cli.mjs pair`). The token is written only to a 0600 file that is
   removed afterwards. It is never an argument, a log line or app state.
3. **Enable Execution on This Mac…** is the owner's consent at the Mac. It
   writes the activation receipt the agent already requires, binding node id,
   release manifest hash and Codex binary hash. Bots still run only after you
   place them on this machine and approve them in DawarTodo.
4. **Start Agent** writes the launchd plist and bootstraps it. Running bots
   keep their existing model, reasoning and Fast settings, full-access
   execution and queues, because the controller never touches the agent's data
   files.

Menu items: status (Connected, Working with the bot names, Reconnecting, Not
responding, Stopped, Stopped unexpectedly, Not paired), Start, Stop…, Reconnect,
Open DawarTodo, version, Check for Updates, Install Update…, Show Logs (opens
Console), Save Diagnostics… (redacted JSON, no credentials), Start at Login
(`SMAppService.mainApp`), Quit (the agent keeps running).

Stop refuses while a turn is running or a tool call is unresolved, and offers
"Stop Anyway". Per-bot Stop stays in DawarTodo. Reconnect does not restart a
busy agent, because the agent already retries its hub connection with backoff.
At login the app starts the agent again only if it was running before.

## 5. Updates

Two keys, both kept offline by the owner. Neither ever goes to the hub.

- **Release key** (Ed25519, Node). Signs release records:
  `node portable/mac-agent/release-tool.mjs keygen --private release.pem --public release-public.pem`
  (the private file is created with mode 0600).
- **Sparkle EdDSA key**. Sparkle's `generate_keys`. Its public half becomes
  `SUPublicEDKey`, and `sign_update <zip>` gives the archive's `edSignature`.

To prepare a release (owner, on the build Mac):

```bash
mac-agent/build-app.sh --version 1.0.1 --build 2 --agent-download … --release-public-key release-public.pem --sparkle-public-key <base64> --sign "Developer ID Application: …" --notary-profile <profile>
```

```bash
node portable/mac-agent/release-tool.mjs record --resources "build/mac-agent/DawarTodo Agent.app/Contents/Resources" --archive build/mac-agent/DawarTodoAgent-1.0.1-2.zip --ed-signature <sign_update output> > record.json
```

```bash
node portable/mac-agent/release-tool.mjs sign --record record.json --key release.pem > envelope.json
```

Publishing means appending `envelope.json` to `<agentDownloadDirectory>/mac/releases.json`
and copying the zip next to it on the hub host. That step is not done here.

What the Mac does:

1. Every 6 hours, and on Check for Updates, the controller sends
   `POST /nodes/releases/mac` with its hello and build, signed by the node key
   (single use, fresh within 5 minutes). The hub answers only enrolled,
   unrevoked nodes. It returns the newest listed record whose
   `hub.protocols`/`hub.runtimes` include its own, and says whether it still
   accepts this client's hello.
2. The controller verifies the record against `release-public-key.pem`,
   downloads the archive with a signed `POST /nodes/releases/mac/download`
   (listed names only, size checked), checks bytes and SHA-256, and writes a
   local `appcast.xml`.
3. Sparkle installs from that local appcast and verifies `edSignature` again.
   Replacing the app does not touch the running agent.
4. The new app's install step stages its agent release. `apply-staged` runs
   every 5 s and switches only when no turn is running and no tool call is
   unresolved (or the agent is stopped). It writes the new activation, keeps
   the previous release and activation, and restarts the launchd job.
5. Health: if the new release is not connected and ready within 180 s, or it
   exits, the controller restores the previous activation and release,
   restarts, and never stages that release again.

Compatibility: an older client the hub still accepts keeps running during a
staged rollout. A client the hub rejects shows "Update required: <reason>".
Its data and queued input are untouched. There is no remote shell, no install
URL and no hub-side signing.

## 6. Production signing and notarization (owner dependencies)

- A Developer ID Application identity in the build Mac's keychain, and
  `xcrun notarytool store-credentials <profile>`. Both are owner decisions and
  accounts; none was created or inferred.
- `Agent.entitlements` gives Node `allow-jit` and
  `allow-unsigned-executable-memory`. Every bundled Mach-O is re-signed with
  the same identity, so library validation accepts sharp's addon.
- **Risk to check on the Mac:** the Codex binary is re-signed without
  entitlements. If Codex needs any (for example for its sandbox), signing
  must keep them (`--preserve-metadata=entitlements`).

## Physical Mac acceptance

Run each of these on the owner's Mac and record the result. None was done here.

1. Build: `build-app.sh` completes. `codesign --verify --deep --strict` passes.
   `file` on `Resources/node/bin/node` and `Resources/codex/vendor/aarch64-apple-darwin/bin/codex` shows arm64.
2. First launch from `/Applications`: the menu bar icon appears. Install
   succeeds. `verify-runtime` returns `codex-cli 0.162.1`.
3. Pairing: the fingerprint matches Settings. The pairing file works.
   Retrying after a lost acknowledgement reuses the original grant.
4. Enable + Start: the launchd job runs and the status shows Connected. The
   version handshake is accepted by the hub. Placing one disposable bot shows
   Working with its name.
5. Login: with Start at Login on, log out and back in. The app starts, and the
   agent starts only if it was running before.
6. Offline/reconnect: turn Wi-Fi off. The status shows Reconnecting. Turn it
   back on and it reconnects with no lost queued messages and no repeated
   callbacks.
7. Stop while a turn is running shows the warning. Stop Anyway interrupts.
   Original queue ids survive.
8. Upgrade while busy: install build N+1 during a turn. The agent switch
   waits, then completes after the turn settles. Settings, workspaces and
   history are preserved.
9. Failed update: a deliberately broken N+2 rolls back to N+1 within 180 s,
   and is not retried.
10. Sparkle installs from the local `file://` appcast. This is untested
    anywhere. If it refuses file URLs, serve the staged appcast over loopback
    instead.
11. Diagnostics export holds no tokens or keys. Logs open in Console.

## Verified on Linux (`node --test tests/mac-agent-*.test.mjs`)

- `mac-agent-runtime`: package-owned layout resolution, tamper refusal, launch
  diagnostics (exit/signal/ENOENT, redaction), Mach-O arch parsing, and the real
  pinned archive when present.
- `mac-agent-bundle`: Resources staging, pinned Node hash parity with the
  installer, arm64-only enforcement, tamper and exec-bit detection, exclusive
  installs, release records.
- `mac-agent-releases`: signed records, compatible-release selection,
  enrolled/unrevoked/fresh/single-use node requests, archive allow-listing,
  the status feed.
- `mac-agent-controller`: install, pairing via the existing enrollment,
  activation binding, the launchd protocol (fake launchctl), Stop/Reconnect
  safety, upgrade while busy with data preserved, health rollback, update
  staging with a local appcast, redacted diagnostics.
- `mac-agent-app-sources`: every command the Swift app calls exists. Status
  fields and phases match. Info.plist, Package.swift and records agree on the
  macOS floor. The build script is valid bash, refuses off macOS and seals
  after signing. The shipped download resolves every controller import.

Not verified anywhere: the Swift code compiling, Sparkle behaviour, launchd on
macOS, SMAppService, Gatekeeper/notarization, or the hub routes in a deployed
gateway.

## Known limits and follow-ups

- The hub does not yet trigger checks remotely. A check needs the Mac's
  6-hour timer or the menu item. Adding a hub → node `release.check` frame
  would let the cloud ask a node to check and stage now.
- Mac capabilities stay as before: desktop, voice and secure transfer are
  refused for darwin by `compatible()`.
- If the command-line installer already ran on this Mac, its `config.json`
  is kept and only `agent.statusFile` is added. If its `releases/<source>`
  differs from the app's copy, install stops with "Bundle file changed". Use
  either the app or the command-line installer on a given Mac, not both.
- Pre-existing and dormant: the agent download ships `control-protocol.mjs`
  without its `hub-teams.mjs` import. Nothing shipped loads it at runtime
  (the agent is bundled), so it is out of scope here.
