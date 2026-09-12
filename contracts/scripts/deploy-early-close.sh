#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/greekbet-target}"
cd "$(dirname "$0")/.."
SO="$CARGO_TARGET_DIR/deploy/greekbet.so"
KP="$CARGO_TARGET_DIR/deploy/greekbet-keypair.json"
echo "Deploying $(solana-keygen pubkey "$KP") from $SO"
solana balance --url https://api.devnet.solana.com
solana program deploy "$SO" \
  --program-id "$KP" \
  --url https://api.devnet.solana.com \
  --with-compute-unit-price 1000
echo "Deployed. Set NEXT_PUBLIC_GREEKBET_PROGRAM_ID=$(solana-keygen pubkey "$KP")"
