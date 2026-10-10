#!/bin/bash
set -euo pipefail
umask 077
agent_source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
case "$(uname -s)" in Darwin) agent_platform=darwin; agent_install_base="$HOME/Library/Application Support/DawarTodo" ;; Linux) agent_platform=linux; agent_install_base="${XDG_DATA_HOME:-$HOME/.local/share}/dawartodo" ;; *) echo 'This installer supports macOS and Linux.'; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) agent_arch=arm64 ;; x86_64) agent_arch=x64 ;; *) echo 'Unsupported machine architecture.'; exit 1 ;; esac
case "$agent_platform-$agent_arch" in
 darwin-arm64) agent_node_hash=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
 darwin-x64) agent_node_hash=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
 linux-arm64) agent_node_hash=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
 linux-x64) agent_node_hash=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
esac
mkdir -p "$agent_install_base/runtime"
agent_node_name="node-v24.21.0-$agent_platform-$agent_arch"
agent_node="$agent_install_base/runtime/$agent_node_name/bin/node"
if [ ! -x "$agent_node" ]; then
 agent_tmp="$(mktemp -d "$agent_install_base/runtime/install.XXXXXX")"
 trap 'rm -rf -- "$agent_tmp"' EXIT
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 180 "https://nodejs.org/dist/v24.21.0/$agent_node_name.tar.gz" -o "$agent_tmp/node.tar.gz"
 if command -v shasum >/dev/null; then agent_actual_hash="$(shasum -a 256 "$agent_tmp/node.tar.gz" | cut -d ' ' -f 1)"; else agent_actual_hash="$(sha256sum "$agent_tmp/node.tar.gz" | cut -d ' ' -f 1)"; fi
 [ "$agent_actual_hash" = "$agent_node_hash" ] || { echo 'Node download checksum failed. Nothing has been started.'; exit 1; }
 tar -xzf "$agent_tmp/node.tar.gz" -C "$agent_tmp"
 [ ! -e "$agent_install_base/runtime/$agent_node_name" ] || { echo 'Runtime destination appeared during installation. Inspect it before continuing.'; exit 1; }
 mv "$agent_tmp/$agent_node_name" "$agent_install_base/runtime/"
fi
export PATH="$(dirname -- "$agent_node"):$PATH"
"$agent_node" "$agent_source_dir/portable/setup.mjs" --base "$agent_install_base" --source "$agent_source_dir"
