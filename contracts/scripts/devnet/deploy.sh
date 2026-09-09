#!/usr/bin/env bash
#
# scripts/devnet/deploy.sh — T10 step 2.
#
#   bash scripts/devnet/deploy.sh
#
# Build at sbpf v0 and deploy to devnet. Run scripts/devnet/setup.sh first.
#
# ## Three things here are load-bearing
#
# 1. **`anchor build --arch v0`.** Anchor 1.2.0 defaults to `--arch v3`. Agave
#    cannot load an sbpf v3 ELF: `solana program deploy` fails outright with
#    `ELF error: ... invalid file header`. Devnet runs the same Agave line, so
#    this is not a local-validator quirk. See docs/TOOLCHAIN.md §5.
#
# 2. **The `.so` is wiped first, the keypair never is.** A stale v0 `.so` left
#    in $CARGO_TARGET_DIR/deploy makes a broken v3 build look like it worked
#    (observed in T00). But `deploy/greekbet-keypair.json` in that same
#    directory *is the program id* — `anchor build` silently generates a new one
#    if it is missing, which changes the program id and orphans whatever is
#    already deployed. It lives in ~/.cache, not in the repo, and it is
#    gitignored. So: wipe `*.so`, back the keypair up, and refuse to proceed if
#    it does not match `declare_id!`.
#
#    This is not hypothetical. When T10 started, the keypair in the cache was
#    `4M7TNCJ2ccrzF3D7uufuM1WYb6d2Xjvij8hnfwypZTsq` — a regenerated one — while
#    `declare_id!` said `GRUTmt...`. Deploying then would have put the program
#    at an address the program itself rejects.
#
# 3. **`--provider.cluster devnet`,** not the ambient `solana config`. Anchor
#    reads `[provider] cluster` from Anchor.toml, which is `localnet`.
#
# ## Cost
#
# `solana program deploy` allocates 2x the `.so` size so the program can be
# upgraded in place, and pays rent-exemption on it up front. For the 327 KB
# artifact that is ~1.67 SOL. Redeploying to the *same* program id reuses the
# existing programdata account and costs only transaction fees (~0.001 SOL), so
# iterate freely once the first deploy has landed. `--force-new` is deliberately
# not offered here: a fresh program id costs another 1.67 SOL.
#
# Upgrade authority stays the local deploy keypair (plan §3 — fast iteration, no
# lockdown in this phase).

set -uo pipefail

. "$HOME/.greekbet-env.sh" 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$HERE/../.." && pwd)"
cd "$WORKSPACE" || exit 1

DEVNET_RPC="https://api.devnet.solana.com"
PROGRAM_ID="GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ"
TARGET="${CARGO_TARGET_DIR:-$WORKSPACE/target}"
DEPLOY_DIR="$TARGET/deploy"
PROGRAM_KEYPAIR="$DEPLOY_DIR/greekbet-keypair.json"
SO="$DEPLOY_DIR/greekbet.so"
BACKUP_DIR="$HOME/.greekbet-devnet/keypair-backups"
WALLET="${GB_WALLET:-$HOME/.config/solana/id.json}"

hr() { printf '%s\n' "------------------------------------------------------------"; }

hr
echo "GreekBet devnet deploy"
echo "workspace: $WORKSPACE"
echo "target   : $TARGET"
hr

# --- 1. the program keypair must exist and must match declare_id! ------------

echo "## program keypair guard"
if [ ! -f "$PROGRAM_KEYPAIR" ]; then
  echo "FATAL: $PROGRAM_KEYPAIR is missing."
  echo "Restore it from a backup (see $BACKUP_DIR) before building."
  echo "Building without it mints a NEW program id."
  exit 1
fi
ACTUAL_ID="$(solana address -k "$PROGRAM_KEYPAIR")"
echo "keypair id : $ACTUAL_ID"
echo "declare_id!: $PROGRAM_ID"
if [ "$ACTUAL_ID" != "$PROGRAM_ID" ]; then
  echo "FATAL: keypair/declare_id! mismatch. Refusing to deploy."
  echo "Restore the correct keypair, or run 'anchor keys sync' and remember it"
  echo "only rewrites [programs.<configured cluster>] — check BOTH localnet and"
  echo "devnet in Anchor.toml afterwards."
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cp -f "$PROGRAM_KEYPAIR" "$BACKUP_DIR/greekbet-keypair.$ACTUAL_ID.json"
echo "backed up to $BACKUP_DIR/greekbet-keypair.$ACTUAL_ID.json"
echo

# --- 2. wipe only the .so ----------------------------------------------------

echo "## wiping stale build artifacts (keypair preserved)"
rm -fv "$SO"
rm -rfv "$TARGET/sbpf-solana-solana/release/greekbet.so" 2>/dev/null
echo

# --- 3. build ----------------------------------------------------------------

echo "## anchor build --arch v0"
BUILD_START=$(date +%s)
if ! anchor build --arch v0; then
  echo "FATAL: anchor build --arch v0 failed."
  exit 1
fi
echo "build took $(( $(date +%s) - BUILD_START ))s"
echo

if [ ! -f "$SO" ]; then
  echo "FATAL: $SO was not produced."
  exit 1
fi
echo "artifact: $SO ($(stat -c %s "$SO") bytes)"
echo "ELF header (must NOT say 'CPU Version: 3'):"
readelf -h "$SO" 2>/dev/null | grep -Ei 'machine|flags' | sed 's/^/  /'
echo

# --- 4. deploy ---------------------------------------------------------------

echo "## balance before"
solana balance --url "$DEVNET_RPC" -k "$WALLET"
echo

echo "## anchor deploy --provider.cluster devnet"
DEPLOY_LOG="$(mktemp)"
anchor deploy --provider.cluster devnet --provider.wallet "$WALLET" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_RC=${PIPESTATUS[0]}
echo

echo "## balance after"
solana balance --url "$DEVNET_RPC" -k "$WALLET"
echo

# --- 5. verify ---------------------------------------------------------------
#
# `anchor deploy`'s exit code is NOT a reliable verdict on devnet, so the
# authority here is the chain.
#
# Anchor 1.2.0 does two things under one command: it deploys the `.so`, and then
# it uploads the IDL into a program-metadata account (program
# `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, seed "idl"). On devnet the
# second half failed for us:
#
#     Writing metadata account...
#     [Error] The provided transaction plan failed to execute. ...
#     Error: Failed to initialize IDL
#
# and `anchor deploy` exited 1 — while `solana program show` reported the
# program deployed, executable, and at the right size. Treating that exit code
# as fatal would mean redeploying a program that is already live, at ~1.67 SOL a
# time. So: check the chain, and only fail if the *program* is not there.
#
# The failed half is not on the critical path. Nothing in this repo reads the
# on-chain IDL — `anchor.workspace` and tests/devnet/lifecycle.ts both load
# $CARGO_TARGET_DIR/idl/greekbet.json from disk. See docs/DEVNET.md.

echo "## on-chain verification"
SHOW="$(solana program show "$PROGRAM_ID" --url "$DEVNET_RPC" 2>&1)"
echo "$SHOW" | sed 's/^/  /'
echo

if ! printf '%s' "$SHOW" | grep -q "^Program Id: $PROGRAM_ID"; then
  echo "FATAL: $PROGRAM_ID is not deployed on devnet (anchor deploy exited $DEPLOY_RC)."
  echo "If the failure left a mid-flight buffer, recover with:"
  echo "  solana program show --buffers --url $DEVNET_RPC"
  echo "  solana program deploy --url $DEVNET_RPC --buffer <BUF> \\"
  echo "      --program-id $PROGRAM_KEYPAIR $SO"
  echo "and reclaim abandoned buffers with 'solana program close <BUF>'."
  rm -f "$DEPLOY_LOG"
  exit 1
fi

ONCHAIN_LEN="$(printf '%s' "$SHOW" | awk '/^Data Length:/ {print $3}')"
LOCAL_LEN="$(stat -c %s "$SO")"
if [ "$ONCHAIN_LEN" != "$LOCAL_LEN" ]; then
  echo "WARNING: on-chain data length ($ONCHAIN_LEN) != local .so ($LOCAL_LEN)."
  echo "The deployed binary may not be the one just built."
fi

if [ "$DEPLOY_RC" -ne 0 ]; then
  if grep -q "Failed to initialize IDL" "$DEPLOY_LOG"; then
    echo "NOTE: the program deployed; only Anchor's on-chain IDL upload failed."
    echo "      Nothing here reads the on-chain IDL. Retry it separately, at your"
    echo "      own SOL cost, with:  anchor idl init --provider.cluster devnet \\"
    echo "        --filepath $TARGET/idl/greekbet.json $PROGRAM_ID"
  else
    echo "NOTE: anchor deploy exited $DEPLOY_RC but the program IS on chain."
    echo "      Read the log above before assuming this deploy is good."
  fi
fi
rm -f "$DEPLOY_LOG"
echo

hr
echo "PROGRAM ID: $PROGRAM_ID"
echo "CLUSTER   : devnet ($DEVNET_RPC)"
echo "EXPLORER  : https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
hr
echo "next: bash scripts/devnet/run-lifecycle.sh"
