#!/usr/bin/env bash
# Measure the LMSR crate's Solana compute-unit cost (ticket T04, item 4).
#
#   wsl -e bash -lc "bash /mnt/c/<...>/crates/lmsr/benches/solana_cu_probe/run.sh"
#
# Assembles a throwaway two-crate workspace in $HOME/gb-cu (outside the repo, so
# the GreekBet workspace never acquires a Solana dependency), builds the probe
# for the SBF target with the toolchain docs/TOOLCHAIN.md pins, and runs it
# under LiteSVM. Results also land in $HOME/gb-cu/cu.out.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LMSR="$(cd "$HERE/../.." && pwd)"
ROOT="${GB_CU_DIR:-$HOME/gb-cu}"

# shellcheck disable=SC1091
[ -f "$HOME/.greekbet-env.sh" ] && . "$HOME/.greekbet-env.sh"

rm -rf "$ROOT"
mkdir -p "$ROOT/probe/src" "$ROOT/harness/tests"

# --- probe: the on-chain program -------------------------------------------
cat > "$ROOT/probe/Cargo.toml" <<EOF
[workspace]

[package]
name = "cu-probe"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
solana-program = "3"
lmsr = { path = "$LMSR" }

# Must match the GreekBet workspace root, or the measurement is of a different
# binary than the one that would be deployed.
[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
EOF
cp "$HERE/probe_lib.rs" "$ROOT/probe/src/lib.rs"

# --- harness: LiteSVM on the host ------------------------------------------
cat > "$ROOT/harness/Cargo.toml" <<'EOF'
[workspace]

[package]
name = "cu-harness"
version = "0.1.0"
edition = "2021"

[dependencies]

[dev-dependencies]
litesvm = "0.16"
solana-sdk = "4"
EOF
cp "$HERE/harness_cu.rs" "$ROOT/harness/tests/cu.rs"

# --arch v0 is mandatory: docs/TOOLCHAIN.md §5. (v3 also fails to build here —
# platform-tools v1.52 ships no `std` for that target.)
( cd "$ROOT/probe" && cargo-build-sbf --arch v0 )

export PROBE_SO="${CARGO_TARGET_DIR:-$ROOT/probe/target}/deploy/cu_probe.so"
ls -l "$PROBE_SO"

( cd "$ROOT/harness" && cargo test --release -- --nocapture ) | tee "$ROOT/cu.out"
echo
echo "Results also in $ROOT/cu.out"
echo "Update crates/lmsr/tests/compute_budget.rs and benches/compute_units.rs if they moved."
