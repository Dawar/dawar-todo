#!/bin/bash
# Build "DawarTodo Agent.app" for Apple Silicon. Runs on macOS (arm64) with
# Xcode 15+ or the Command Line Tools (Swift 5.9+). See mac-agent/MAC_AGENT.md.
#
#   mac-agent/build-app.sh --version 1.0.0 --build 1 \
#     --agent-download dist/agent-downloads/dawartodo-agent-<sha12> \
#     [--node-tarball node-v24.21.0-darwin-arm64.tar.gz] \
#     [--release-public-key release-public.pem] [--sparkle-public-key BASE64] \
#     [--sign "Developer ID Application: …"] [--notary-profile PROFILE]
#
# Without --sign the app is ad-hoc signed for local testing only. Nothing is
# uploaded or published; the result is build/mac-agent/DawarTodoAgent-V-N.zip.
set -euo pipefail
umask 022

version='' build='' agent_download='' node_tarball='' release_key='' sparkle_key='' identity='' notary=''
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --build) build="$2"; shift 2 ;;
    --agent-download) agent_download="$2"; shift 2 ;;
    --node-tarball) node_tarball="$2"; shift 2 ;;
    --release-public-key) release_key="$2"; shift 2 ;;
    --sparkle-public-key) sparkle_key="$2"; shift 2 ;;
    --sign) identity="$2"; shift 2 ;;
    --notary-profile) notary="$2"; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '--version x.y.z is required' >&2; exit 2; }
[[ "$build" =~ ^[1-9][0-9]*$ ]] || { echo '--build N (positive, increasing) is required' >&2; exit 2; }
[ -n "$agent_download" ] && [ -f "$agent_download/manifest.json" ] || { echo '--agent-download must be an exact dist/agent-downloads/dawartodo-agent-<sha12> directory' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'Build the app on macOS. Linux can produce the agent download only.' >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo 'Build on Apple Silicon so npm selects the darwin-arm64 packages.' >&2; exit 1; }
command -v swift >/dev/null || { echo 'Swift is missing: install Xcode or run xcode-select --install.' >&2; exit 1; }

repo="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
out="$repo/build/mac-agent"
work="$out/work-$build"
app="$out/DawarTodo Agent.app"
node_name=node-v24.21.0-darwin-arm64
rm -rf -- "$work" "$app"
mkdir -p "$work"

# 1. Pinned Node runtime (bundle.mjs verifies the same hash the installer uses).
if [ -z "$node_tarball" ]; then
  node_tarball="$work/$node_name.tar.gz"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 \
    "https://nodejs.org/dist/v24.21.0/$node_name.tar.gz" -o "$node_tarball"
fi
tar -xzf "$node_tarball" -C "$work"
node="$work/$node_name/bin/node"
"$node" --version | grep -qx v24.21.0

# 2. Agent dependencies from the reviewed lock, for darwin-arm64, no scripts,
# no links (the app copies plain files only).
mkdir -p "$work/deps"
cp "$agent_download/package.json" "$agent_download/package-lock.json" "$work/deps/"
(cd "$work/deps" && PATH="$work/$node_name/bin:/usr/bin:/bin" npm ci --ignore-scripts --no-bin-links --omit=dev --no-audit --no-fund)

# 3. Resources: Node, Codex platform package, agent release, licenses, receipts.
key_args=()
if [ -n "$release_key" ]; then key_args=(--release-public-key "$release_key"); fi
"$node" "$repo/portable/mac-agent/release-tool.mjs" stage --agent-download "$agent_download" \
  --node-modules "$work/deps/node_modules" --node-tarball "$node_tarball" --out "$work/Resources" \
  --app-version "$version" --build "$build" --arch arm64 ${key_args[@]+"${key_args[@]}"} > "$work/stage.json"
agent_source="$("$node" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).release.agentSource)' "$work/stage.json")"

# 4. Sign every bundled Mach-O inside-out, then re-seal the hashes, since
# signing rewrites those bytes. Developer ID uses the hardened runtime and a
# timestamp; without --sign the code is ad-hoc signed for local testing only.
if [ -n "$identity" ]; then sign=(codesign --force --timestamp --options runtime --sign "$identity")
else sign=(codesign --force --sign -); fi
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then "${sign[@]}" "$file"; fi
done < <(find "$work/Resources" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.node' \) ! -path "$work/Resources/node/bin/node" -print0)
"${sign[@]}" --entitlements "$repo/mac-agent/Agent.entitlements" "$work/Resources/node/bin/node"
"$node" "$repo/portable/mac-agent/release-tool.mjs" seal --resources "$work/Resources" > "$work/seal.json"

# 5. Native menu bar executable (+ Sparkle).
swift build -c release --arch arm64 --package-path "$repo/mac-agent/AgentApp"
bin="$(swift build -c release --arch arm64 --package-path "$repo/mac-agent/AgentApp" --show-bin-path)"
sparkle="$(find "$repo/mac-agent/AgentApp/.build/artifacts" -path '*macos-arm64_x86_64/Sparkle.framework' -type d | head -n 1)"
[ -d "$sparkle" ] || { echo 'Sparkle.framework was not resolved by SwiftPM.' >&2; exit 1; }

# 6. Assemble the bundle.
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp "$bin/DawarTodoAgent" "$app/Contents/MacOS/DawarTodoAgent"
ditto "$sparkle" "$app/Contents/Frameworks/Sparkle.framework"
ditto "$work/Resources" "$app/Contents/Resources"
sed -e "s/@APP_VERSION@/$version/" -e "s/@BUILD@/$build/" -e "s/@AGENT_SOURCE@/$agent_source/" \
  -e "s|@SPARKLE_PUBLIC_ED_KEY@|${sparkle_key}|" "$repo/mac-agent/Info.plist.template" > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist"
[ -n "$sparkle_key" ] || echo 'warning: no --sparkle-public-key; Sparkle will refuse every update for this build.' >&2

# 7. Sign the app shell (Resources code was signed and sealed in step 4).
fw="$app/Contents/Frameworks/Sparkle.framework"
# Sparkle's documented inside-out order for re-signing its helpers.
for nested in Versions/B/XPCServices/Installer.xpc Versions/B/Autoupdate Versions/B/Updater.app; do
  if [ -e "$fw/$nested" ]; then "${sign[@]}" "$fw/$nested"; fi
done
if [ -e "$fw/Versions/B/XPCServices/Downloader.xpc" ]; then "${sign[@]}" --preserve-metadata=entitlements "$fw/Versions/B/XPCServices/Downloader.xpc"; fi
"${sign[@]}" "$fw"
"${sign[@]}" "$app"
codesign --verify --deep --strict "$app"

# 8. Archive, and notarize only when a notary profile was given.
zip="$out/DawarTodoAgent-$version-$build.zip"
rm -f -- "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
if [ -n "$notary" ]; then
  [ -n "$identity" ] || { echo 'Notarization requires --sign with a Developer ID identity.' >&2; exit 1; }
  xcrun notarytool submit "$zip" --keychain-profile "$notary" --wait
  xcrun stapler staple "$app"
  rm -f -- "$zip"; ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
fi
echo "Built $app"
echo "Archive $zip sha256 $(shasum -a 256 "$zip" | cut -d ' ' -f 1)"
echo "Next: Sparkle sign_update \"$zip\" gives the edSignature for release-tool.mjs record. Nothing was published."
