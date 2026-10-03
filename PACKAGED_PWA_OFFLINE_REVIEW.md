# Packaged PWA offline release smoke — 2026-09-27

**Baseline actual package/SW offline reopen is proven.** The default baseline smoke passed against the existing **9a60ceaa897f1c08f89d09a3eb25b6633da5468b** dist artifact, served by root's isolated local workerd at `http://127.0.0.1:37931`. Main source and this test branch were already at `bc93e48` during the run; no rebuild occurred. They are deliberately recorded separately from the artifact's declared source commit.

No production/shared modules or prior layout fixtures changed. Only this note, `tests/packaged-pwa-offline-smoke.mjs`, and `tests/fixtures/packaged-pwa-storage.mjs` are added. Root's preview was not stopped/restarted, and nothing was merged, pushed or deployed.

## Exact artifact and execution

- SHA-256 of the 69 files under actual `dist/client` and `dist/server`: `17d6e14b1a80767061759b5d43eb55f842545eb8ff21734c5bfae02664b8fbf3`, unchanged before/after both recorded runs.
- Served packaged `/sw.js` matched the on-disk asset: `a85a6a32975e1e500ab9b5de80e01406353fb0c086cd30015e4f8f0d59bb0454`.
- Fresh Headless Chromium 154 on Linux, 390 × 844 viewport; temporary profile, restarted orderly with the same profile, then removed after verification.
- A temporary proxy listens only on 127.0.0.1 and forwards to root's local workerd with its supported upstream Host. Chrome maps `pwa-review.localhost` to 127.0.0.1. Browser verification returned `isSecureContext: true`, service worker available.
- The **unchanged packaged PwaRegister automatically registered `/sw.js`**. No serviceWorker/cache/navigator patches, synthetic page shell, replacement page bundle, or real owner/session was used. The alias avoids the intentional localhost development cleanup.
- Production SW `dawar-todo-shell-v32` completed caching: 32 entries, including `/`, `/bots` and 21 JavaScript assets. Real root and bot documents were warmed before claiming repeat offline access.
- After fixtures were staged, API traffic was blocked. Offline mode applies CDP network emulation and request failure to page/worker targets, terminates any existing proxy streams and denies all proxy upstream access. HTTP cache was cleared and disabled. An uncached API probe failed; zero upstream requests occurred during offline navigation/restart.
- Four new offline documents (`/bots`, `/`, then `/` and `/bots` after browser restart) returned 200 **from the production service worker**. Sixty built script responses came from its cache. Actual React UI assertions succeeded; zero uncaught browser exceptions or attempted public-origin requests were recorded.

Chromium reports these Cache Storage document responses as both `fromServiceWorker` and `fromDiskCache`. These flags are not treated as mutually exclusive. Explicit HTTP-cache clearing/disabling, native SW attribution, the failed uncached probe and zero upstream traffic distinguish the tested path from ordinary HTTP-cache fallback.

## Data and lifecycle assertions

The injected helper imports only storage modules from `git show <declared-built-commit>:<path>`, bundled with esbuild. Module hashes appear in the result; it does not use moving main source or replace the built app's store/UI/client. It stages one synthetic offline task with a small text file, one synthetic bot snapshot/history, and one unsent bot draft with a PNG. Quick Add text and a separate image are entered through the real UI. No seeded sample task content is printed or changed. API blocking begins before synthetic writes, so these fixtures never sync to the temporary server.

Passing checks:

- Task appears in the real cached list; Quick Add text restores into an enabled, visible input on a new document and browser restart. The reopened input accepts further typing and commits it offline.
- Bot cached snapshot/history and unsent text restore through actual shell navigation, fresh offline documents and browser restart. An additional offline text edit survives. The staged image preview decodes from an object URL. No send operations are created.
- Exact original task attachment and bot PNG hashes survive all checkpoints: task file `48f73282f203f0bb478bdbe6df5a28c52973f10039a7e2cd91f2719d6f940972`, PNG `66a09b4a04061b236cb9d47bc85d07e69234192c586c1ec7541c85bb4ee7d9e3`.
- A second real service-worker generation registers at `/sw.js?packaged-smoke-generation=2`, activates and claims the existing page without navigating it. The served bytes are verified identical to the packaged SW; text and file hashes stay intact. This is a lifecycle check, **not** a new app build/cache-version rollout.

Known baseline limit: the **Quick Add unsent image** survives same-document shell navigation but disappears on a new document. Its original fixture bytes and durable task/bot copies remain intact; the missing capture file is reported, never reseeded to hide the failure. This artifact predates the task capture pass. Baseline mode records that absence; **the final release gate requires capture-file recovery and fails on it**. The strict gate was run against 9a and failed solely on this expected missing capability, while the actual package/SW/task/bot assertions still passed.

## Repeat against the final combined artifact

Run from this repository with root's stable local preview already running. Declare the source commit that was actually built, even if current main differs:

```sh
PWA_SMOKE_BUILT_COMMIT=<actual-built-commit> \
PWA_SMOKE_UPSTREAM=http://127.0.0.1:37931 \
PWA_SMOKE_REQUIRE_CAPTURE_FILES=1 \
node tests/packaged-pwa-offline-smoke.mjs
```

Defaults for source and artifact directories are `/home/dawar/ChatGPT/dawar-todo` and its `dist`; override `PWA_SMOKE_SOURCE_ROOT` / `PWA_SMOKE_ARTIFACT_ROOT` if needed. `PWA_SMOKE_OUTPUT` chooses a distinct evidence directory. `BOT_TEST_CHROME` can select the Chrome executable. The built-commit argument is required, never inferred from current HEAD. Use `PWA_SMOKE_REQUIRE_CAPTURE_FILES=1` for the final release; omission is baseline observation mode.

The runner hashes the artifact before/after and fails closed if it changed. Discard that run and repeat the same deterministic fixtures with a fresh profile after root supplies the stable artifact commit. It cannot safely infer a rebuilt artifact's commit from a moving source HEAD. If a future history storage API changes, update only the independent storage helper adapter; do not substitute a page/client implementation.

Checks actually run:

- Baseline command with `PWA_SMOKE_BUILT_COMMIT=9a60cea`: **exit 0**.
- Same command with `PWA_SMOKE_REQUIRE_CAPTURE_FILES=1` and separate output: **exit 1 only for missing Quick Add capture image**, proving the final gate remains capable of failing.
- Targeted ESLint for both new `.mjs` files: **passed, no warnings**.
- No app rebuild or new full unit/type suite was run for this test-only task; root owns the final combined build and checks.

Evidence directories: `outputs/packaged-pwa-offline/` and `outputs/packaged-pwa-offline-final-gate/`, each containing privacy-safe `result.json`, a Quick Add form-only screenshot and synthetic bot screenshot. Earlier draft/layout review evidence remains separate under `outputs/bot-release-review/` and `BOT_DRAFT_RELEASE_REVIEW.md`.

## Explicit limits

The proxy exposes manifest/icon absolute URLs using the upstream `https://127.0.0.1:37931` authority; the browser policy blocks that alternate loopback origin. Same-origin SW app/asset caching passes, but **installability metadata through this proxy is not verified**. These blocked requests are recorded, and no public DNS/tunnel/service is used.

No actual iPhone/Safari, physical keyboard, standalone installation, physical OS kill, storage eviction/disk failure, live account/auth session, bot relay/native send, S3 upload, or new-version rollout was tested. A 390 px Chromium viewport is emulation. Orderly browser restart with exact recovered bytes is not evidence of physical OS-kill durability. This packaged smoke does not replace the independent narrow-layout release gate, which remains owned by the chat/task specialists.
