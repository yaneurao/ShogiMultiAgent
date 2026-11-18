#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"
cargo build --release --manifest-path agent-build/Cargo.toml --target-dir target --target x86_64-pc-windows-gnu
mkdir -p agent
cp target/x86_64-pc-windows-gnu/release/shogizone-participant-agent.exe agent/usi-agent3.exe
npm run package:win
