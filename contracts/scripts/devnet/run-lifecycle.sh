#!/usr/bin/env bash
#
# scripts/devnet/run-lifecycle.sh — T10 step 5: run the devnet lifecycle.
#
#   bash scripts/devnet/run-lifecycle.sh
#
# Runs `scripts/devnet/fund.ts` (idempotent — it reuses persisted wallets and
# tops them up only if they are short) and then mocha over
# `tests/devnet/lifecycle.ts` only.
#
# ## Why this is not `anchor test`
#
# `anchor test` starts a validator, and Anchor 1.2's default validator is
# surfpool, which is not installed. `anchor test --skip-local-validator` exists
# but still wants to build. There is nothing to build here — the program is
# already on devnet — so this drives ts-mocha directly with the same flags
# Anchor.toml's `[scripts] test` uses.
#
# ## The two flags that are load-bearing (both from T09, both still true here)
#
# * `NODE_OPTIONS=--no-experimental-strip-types` forces mocha down its
#   `require()` path so **ts-node** transpiles the suite. Node 24 strips types
#   natively and mocha 9 tries `import()` first; node's strip-only mode then
#   rejects ordinary TypeScript (parameter properties, enums) with a bare
#   SyntaxError, and which loader wins depends on whether every import in the
#   file happens to resolve as ESM.
# * The spec list is exactly one file. Anchor.toml's glob is `tests/**/*.ts`,
#   which would pull in the local suite as well; those tests airdrop SOL and
#   mint collateral at will and cannot run against devnet.
#
# `tests/devnet/lifecycle.ts` also skips itself unless ANCHOR_PROVIDER_URL names
# devnet, so the reverse mistake — a local `anchor test` sweeping this file up —
# is safe too.

set -uo pipefail

. "$HOME/.greekbet-env.sh" 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$HERE/../.." && pwd)"
cd "$WORKSPACE" || exit 1

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export NODE_OPTIONS=--no-experimental-strip-types
export TS_NODE_TRANSPILE_ONLY=true

echo "cluster : $ANCHOR_PROVIDER_URL"
echo "wallet  : $ANCHOR_WALLET"
echo

if [ "${GB_SKIP_FUND:-0}" != "1" ]; then
  echo "== funding =="
  node_modules/.bin/ts-node -P tsconfig.json scripts/devnet/fund.ts || exit 1
  echo
fi

echo "== lifecycle =="
node_modules/.bin/ts-mocha -p ./tsconfig.json -t 900000 "tests/devnet/lifecycle.ts"
RC=$?

echo
echo "== treasury balance after =="
solana balance --url "$ANCHOR_PROVIDER_URL" -k "$ANCHOR_WALLET"

exit $RC
