#!/usr/bin/env bash
#
# scripts/devnet/setup.sh — T10 step 1.
#
# Point the Solana CLI at devnet, verify the deploy keypair and the program
# keypair, and report balances. Nothing here spends SOL.
#
#   bash scripts/devnet/setup.sh            # switch to devnet and report
#   bash scripts/devnet/setup.sh --restore  # switch the CLI back to where it was
#
# ## Why there is no airdrop retry loop
#
# The ticket asks for "an airdrop with retry". The public devnet faucet
# (`solana airdrop`, api.devnet.solana.com) is rate-limited *per source IP* and
# during this whole ticket it returned, every single time:
#
#     Error: airdrop request failed. This can happen when the rate limit is
#     reached.
#
# Retrying does not help — the limiter is not transient, it is a quota this IP
# has already spent. A loop just burns wall-clock time and makes the failure
# look like a hang. So this script *asks once*, reports the result, and if the
# balance is short it tells the operator to top the wallet up by hand
# (https://faucet.solana.com, which is captcha-gated and cannot be scripted).
# Pass GB_TRY_AIRDROP=1 to make it try; the default is not to bother.
#
# ## `solana config` is global state
#
# T00 left the CLI pointing at http://localhost:8899 and T09's local suite
# depends on that. This script saves the previous RPC URL to
# ~/.greekbet-devnet/previous-cluster before switching, and `--restore` puts it
# back. Everything else in scripts/devnet/ passes `--url`/`ANCHOR_PROVIDER_URL`
# explicitly, so no other step depends on the ambient config either way.

set -uo pipefail

. "$HOME/.greekbet-env.sh" 2>/dev/null || true

DEVNET_RPC="https://api.devnet.solana.com"
STATE_DIR="$HOME/.greekbet-devnet"
PREV_FILE="$STATE_DIR/previous-cluster"
WALLET="${GB_WALLET:-$HOME/.config/solana/id.json}"
PROGRAM_ID="GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ"
PROGRAM_KEYPAIR="${CARGO_TARGET_DIR:-./target}/deploy/greekbet-keypair.json"

# Rent-exempt cost of the 327 KB program plus headroom for test wallets & fees.
MIN_SOL_FOR_DEPLOY="${GB_MIN_SOL:-2.0}"

mkdir -p "$STATE_DIR"

hr() { printf '%s\n' "------------------------------------------------------------"; }

if [ "${1:-}" = "--restore" ]; then
  if [ -f "$PREV_FILE" ]; then
    prev="$(cat "$PREV_FILE")"
    echo "restoring solana config RPC URL to: $prev"
    solana config set --url "$prev"
  else
    echo "no saved cluster at $PREV_FILE; falling back to localhost"
    solana config set --url http://localhost:8899
  fi
  exit $?
fi

hr
echo "GreekBet devnet setup"
hr

echo "## toolchain"
solana --version
anchor --version
node --version
echo "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<unset>}"
echo

echo "## switching the Solana CLI to devnet"
current_url="$(solana config get 2>/dev/null | awk '/^RPC URL:/ {print $3}')"
if [ -n "$current_url" ] && [ "$current_url" != "$DEVNET_RPC" ]; then
  printf '%s' "$current_url" > "$PREV_FILE"
  echo "saved previous RPC URL ($current_url) to $PREV_FILE"
  echo "  -> restore later with: bash scripts/devnet/setup.sh --restore"
fi
solana config set --url "$DEVNET_RPC" --keypair "$WALLET"
echo

echo "## deploy keypair"
if [ ! -f "$WALLET" ]; then
  echo "FATAL: no keypair at $WALLET."
  echo "  Create one with:  solana-keygen new -o $WALLET"
  exit 1
fi
PUBKEY="$(solana address -k "$WALLET")"
echo "wallet file : $WALLET"
echo "pubkey      : $PUBKEY"
echo

echo "## devnet reachability"
echo -n "cluster version: "
if ! solana cluster-version --url "$DEVNET_RPC"; then
  echo "FATAL: devnet RPC $DEVNET_RPC is not reachable."
  exit 1
fi
echo

echo "## SOL balance"
BAL_RAW="$(solana balance "$PUBKEY" --url "$DEVNET_RPC" 2>&1)"
echo "balance: $BAL_RAW"
BAL="$(printf '%s' "$BAL_RAW" | awk '{print $1}')"
case "$BAL" in
  ''|*[!0-9.]*) BAL=0 ;;
esac

enough="$(awk -v b="$BAL" -v m="$MIN_SOL_FOR_DEPLOY" 'BEGIN{print (b+0 >= m+0) ? "yes" : "no"}')"
if [ "$enough" = "yes" ]; then
  echo "OK: >= $MIN_SOL_FOR_DEPLOY SOL, enough to deploy (~1.7 SOL rent) and run the suite."
else
  echo "SHORT: $BAL SOL is below the $MIN_SOL_FOR_DEPLOY SOL this ticket needs."
  if [ "${GB_TRY_AIRDROP:-0}" = "1" ]; then
    echo "attempting a single airdrop (no retry loop — see the header comment)"
    solana airdrop 2 "$PUBKEY" --url "$DEVNET_RPC" || true
    echo "balance after: $(solana balance "$PUBKEY" --url "$DEVNET_RPC" 2>&1)"
  fi
  echo
  echo "  The public devnet faucet is rate-limited per IP and has been refusing"
  echo "  every request from this host. Top the wallet up by hand:"
  echo "    https://faucet.solana.com  (paste $PUBKEY)"
  echo "  Then re-run this script."
fi
echo

echo "## program keypair (this file IS the program id)"
if [ -f "$PROGRAM_KEYPAIR" ]; then
  ACTUAL="$(solana address -k "$PROGRAM_KEYPAIR")"
  echo "keypair : $PROGRAM_KEYPAIR"
  echo "id      : $ACTUAL"
  echo "expected: $PROGRAM_ID  (declare_id! and both Anchor.toml [programs.*])"
  if [ "$ACTUAL" != "$PROGRAM_ID" ]; then
    echo
    echo "MISMATCH. The keypair in \$CARGO_TARGET_DIR does not match declare_id!."
    echo "That cache is not in the repo and a build regenerates the keypair when"
    echo "it is missing, which mints a *new* program id and orphans anything"
    echo "already deployed. Restore the backup before deploying:"
    echo "  cp <backup>/greekbet-keypair.json '$PROGRAM_KEYPAIR'"
    echo "deploy.sh refuses to run while this is true."
  fi
else
  echo "MISSING: $PROGRAM_KEYPAIR"
  echo "Restore it from a backup before building — a build will otherwise"
  echo "generate a fresh keypair and change the program id."
fi
echo

echo "## is the program already on devnet?"
solana program show "$PROGRAM_ID" --url "$DEVNET_RPC" 2>&1 | sed 's/^/  /'
echo

echo "## collateral mint (docs/DESIGN_DECISIONS.md D3)"
echo "Circle devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
spl-token display 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --url "$DEVNET_RPC" 2>&1 | sed 's/^/  /'
echo
echo "USDC held by $PUBKEY:"
spl-token accounts --url "$DEVNET_RPC" --owner "$PUBKEY" 2>&1 | sed 's/^/  /'
echo

hr
echo "next: bash scripts/devnet/deploy.sh"
hr
