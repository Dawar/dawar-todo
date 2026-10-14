# Dawar bot-avatar-engine

Source: https://github.com/Dawar/bot-avatar-engine
Pinned commit: `6ee5b14cad35bf45c16042b25a2aec88c924af81`
Retrieved September 29, 2026 from upstream main.

The nine source files here are copied from `packages/bot-avatar/src` with the small DOM typing compatibility patch recorded below. `README.upstream.md` preserves the package reference.
No playground, tests, external services or runtime dependencies were imported.

License inspection: this upstream revision contains no LICENSE/COPYING file,
SPDX header or package license declaration. No substitute license is asserted.
Dawar explicitly requested integration of his repository into DawarTodo. This
notice records that provenance and permission context, not a general license
grant to third parties. Preserve upstream attribution when updating this copy.

Local integration patch: renderer.ts uses an equivalent appendChild loop for nine SVG append calls, avoiding the repository’s Cloudflare Element.append type collision. Geometry, timing, behavior and rendering are otherwise upstream source.
