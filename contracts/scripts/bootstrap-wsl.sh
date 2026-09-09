#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# GreekBet — WSL Ubuntu toolchain bootstrap (ticket T00)
#
# Installs, inside WSL Ubuntu, everything needed to run:
#   cargo test / cargo build
#   solana-test-validator
#   anchor build / anchor test
#
# Idempotent: safe to re-run. Already-satisfied steps are skipped.
#
# USAGE (from Windows PowerShell / cmd, repo root):
#
#   wsl -u root -e bash ./scripts/bootstrap-wsl.sh
#
# Run it as root the first time: the apt phase needs root, and interactive
# `sudo` inside `wsl -e` has no TTY to prompt on. When invoked as root the
# script installs the apt packages and then re-executes itself as the normal
# WSL user (uid 1000, or $SUDO_USER / $GB_USER if set) for every user-level
# step, so nothing lands in root's HOME.
#
# Re-runs once apt is satisfied can be done as the normal user:
#
#   wsl -e bash ./scripts/bootstrap-wsl.sh
#
# If the file has CRLF line endings (git `core.autocrlf=true` on Windows will
# do that on checkout), pipe it through sed instead:
#
#   wsl -u root -e bash -c "sed 's/\r$//' ./scripts/bootstrap-wsl.sh | bash -s"
# ---------------------------------------------------------------------------
set -euo pipefail

APT_PACKAGES=(
  build-essential
  pkg-config
  libssl-dev
  libudev-dev
  llvm
  libclang-dev
  protobuf-compiler
  ca-certificates
  curl
  git
  unzip
)

NVM_VERSION="v0.40.3"
# Pinned so the toolchain is reproducible. 1.2.0 is what `avm install latest`
# resolved to when T00 was executed and is the version the smoke test passed on.
# Override with GB_ANCHOR_VERSION=latest (or a specific version) to move it.
ANCHOR_VERSION="${GB_ANCHOR_VERSION:-1.2.0}"
CARGO_TARGET_DIR_VALUE='$HOME/.cache/greekbet-target'
BASHRC_BEGIN="# >>> greekbet toolchain >>>"
BASHRC_END="# <<< greekbet toolchain <<<"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Phase 0 — sanity
# ---------------------------------------------------------------------------
grep -qi microsoft /proc/version 2>/dev/null \
  || warn "this does not look like WSL; continuing anyway"

# ---------------------------------------------------------------------------
# Phase 1 — apt packages (needs root)
# ---------------------------------------------------------------------------
apt_missing() {
  local p missing=()
  for p in "${APT_PACKAGES[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q '^install ok installed$'; then
      missing+=("$p")
    fi
  done
  printf '%s\n' "${missing[@]:-}"
}

install_apt_as_root() {
  local missing
  mapfile -t missing < <(apt_missing)
  # mapfile of an empty printf yields one empty element; filter it.
  local real=()
  local m
  for m in "${missing[@]}"; do [ -n "$m" ] && real+=("$m"); done

  if [ "${#real[@]}" -eq 0 ]; then
    info "all apt packages already installed — skipping apt"
    return 0
  fi

  log "apt: installing ${real[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends "${real[@]}"
}

resolve_target_user() {
  if [ -n "${GB_USER:-}" ]; then echo "$GB_USER"; return; fi
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then echo "$SUDO_USER"; return; fi
  local u
  u=$(getent passwd 1000 | cut -d: -f1 || true)
  [ -n "$u" ] || die "cannot determine the non-root WSL user; set GB_USER=<name> and re-run"
  echo "$u"
}

if [ "$(id -u)" -eq 0 ]; then
  install_apt_as_root

  if [ "${GB_APT_ONLY:-0}" = 1 ]; then
    log "GB_APT_ONLY=1 — stopping after apt phase"
    exit 0
  fi

  TARGET_USER=$(resolve_target_user)
  log "re-executing user-level phases as '$TARGET_USER'"
  # Copy the script somewhere the target user can definitely read/execute from.
  # (/mnt/c is fine to read, but keep it simple and stable.)
  SELF=$(readlink -f "$0")
  RELAY=/tmp/greekbet-bootstrap-relay.sh
  tr -d '\r' < "$SELF" > "$RELAY"
  chmod 0755 "$RELAY"
  chown "$TARGET_USER" "$RELAY"
  exec su - "$TARGET_USER" -c "GB_SKIP_APT=1 bash $RELAY"
fi

# ---------------------------------------------------------------------------
# From here on we are the normal (non-root) user.
# ---------------------------------------------------------------------------
if [ "${GB_SKIP_APT:-0}" != 1 ]; then
  mapfile -t _missing < <(apt_missing)
  _real=()
  for _m in "${_missing[@]}"; do [ -n "$_m" ] && _real+=("$_m"); done
  if [ "${#_real[@]}" -ne 0 ]; then
    if sudo -n true 2>/dev/null; then
      log "apt: installing ${_real[*]} (passwordless sudo)"
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -y
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${_real[@]}"
    else
      die "missing apt packages (${_real[*]}) and sudo needs a password.
       Re-run as root instead:  wsl -u root -e bash ./scripts/bootstrap-wsl.sh"
    fi
  else
    info "all apt packages already installed — skipping apt"
  fi
fi

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export NVM_DIR="$HOME/.nvm"

# ---------------------------------------------------------------------------
# Phase 2 — rustup + stable Rust
# ---------------------------------------------------------------------------
log "rust toolchain"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  info "installing rustup (non-interactive, default profile, stable)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --default-toolchain stable --profile default
else
  info "rustup already present"
fi
export PATH="$CARGO_HOME/bin:$PATH"
rustup toolchain install stable --profile default --no-self-update >/dev/null 2>&1 || true
rustup default stable >/dev/null
info "rustc  $(rustc --version)"
info "cargo  $(cargo --version)"

# ---------------------------------------------------------------------------
# Phase 3 — Solana (Agave) CLI
# ---------------------------------------------------------------------------
log "solana (agave) cli"
if [ ! -x "$SOLANA_BIN/solana" ]; then
  info "installing from release.anza.xyz/stable"
  curl --proto '=https' --tlsv1.2 -sSfL https://release.anza.xyz/stable/install | sh
else
  info "solana already present"
fi
export PATH="$SOLANA_BIN:$PATH"
command -v solana >/dev/null || die "solana not on PATH after install (expected $SOLANA_BIN)"
info "solana $(solana --version)"

# ---------------------------------------------------------------------------
# Phase 4 — Node LTS (nvm) + yarn
#
# NOTE: WSL interop puts the *Windows* npm on PATH (/mnt/c/Program Files/nodejs).
# It cannot run Anchor's TS tests. nvm's PATH entry must come first.
# ---------------------------------------------------------------------------
log "node + yarn"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  info "installing nvm $NVM_VERSION"
  PROFILE=/dev/null curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
else
  info "nvm already present"
fi
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
nvm install --lts >/dev/null
nvm alias default 'lts/*' >/dev/null
nvm use default >/dev/null
info "node $(node --version)  ($(command -v node))"
info "npm  $(npm --version)   ($(command -v npm))"

if ! command -v yarn >/dev/null 2>&1 || [[ "$(command -v yarn)" == /mnt/c/* ]]; then
  info "installing yarn via npm -g"
  npm install -g yarn >/dev/null
  hash -r
fi
info "yarn $(yarn --version)  ($(command -v yarn))"

# ---------------------------------------------------------------------------
# Phase 5 — avm + Anchor
# ---------------------------------------------------------------------------
log "avm + anchor"
if ! command -v avm >/dev/null 2>&1; then
  info "cargo install avm (this compiles from source; several minutes)"
  cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
else
  info "avm already present ($(avm --version 2>/dev/null || echo unknown))"
fi

export PATH="$HOME/.avm/bin:$PATH"
if ! command -v anchor >/dev/null 2>&1; then
  info "avm install $ANCHOR_VERSION (downloads a prebuilt binary when one"
  info "exists, otherwise compiles from source: 10-25 minutes)"
  avm install "$ANCHOR_VERSION"
  avm use "$ANCHOR_VERSION"
else
  info "anchor already present"
fi
# NOTE: Anchor 1.x manages its own Agave/Solana toolchain. The first `anchor`
# invocation runs `agave-install init <pinned version>`, which RE-POINTS
# ~/.local/share/solana/install/active_release at the version Anchor wants —
# so the effective `solana --version` after this step is Anchor's pin, not the
# `release.anza.xyz/stable` build phase 3 downloaded. That is intentional:
# `anchor build`/`anchor test` must run against the toolchain Anchor supports.
info "anchor $(anchor --version)"
info "avm    $(avm --version 2>/dev/null || echo n/a)"
info "solana after anchor toolchain init: $(solana --version)"

# ---------------------------------------------------------------------------
# Phase 6 — solana local config + dev keypair
# ---------------------------------------------------------------------------
log "solana local config"
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  info "generating dev keypair at ~/.config/solana/id.json (no passphrase)"
  mkdir -p "$HOME/.config/solana"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json"
else
  info "keypair already exists"
fi
solana config set --url localhost >/dev/null
solana config set --keypair "$HOME/.config/solana/id.json" >/dev/null
info "pubkey $(solana address)"
solana config get | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Phase 7 — environment wiring
#
# IMPORTANT: Ubuntu's stock ~/.bashrc begins with
#     case $- in *i*) ;; *) return;; esac
# so anything appended to ~/.bashrc is NOT executed by a non-interactive shell.
# `wsl -e bash -lc '<cmd>'` — the way Windows-side agents reach WSL — is a
# LOGIN but NON-INTERACTIVE shell, so a ~/.bashrc-only PATH never applies there.
#
# So: put the real environment in a standalone ~/.greekbet-env.sh and source it
# from BOTH ~/.profile (login shells, incl. non-interactive `bash -lc`) and
# ~/.bashrc (interactive non-login shells).
# ---------------------------------------------------------------------------
log "environment wiring (~/.greekbet-env.sh + ~/.profile + ~/.bashrc)"
ENV_FILE="$HOME/.greekbet-env.sh"
mkdir -p "$HOME/.cache/greekbet-target"

cat > "$ENV_FILE" <<EOF
# Managed by scripts/bootstrap-wsl.sh (ticket T00). Do not hand-edit.
# Sourced from ~/.profile and ~/.bashrc. Must be safe to source repeatedly and
# in a non-interactive shell (no output, no 'return' outside a function).

_gb_path_prepend() {
  case ":\$PATH:" in
    *":\$1:"*) : ;;
    *) PATH="\$1:\$PATH" ;;
  esac
}

# Rust (rustup was installed with --no-modify-path, so we own the PATH entry)
[ -f "\$HOME/.cargo/env" ] && . "\$HOME/.cargo/env"
_gb_path_prepend "\$HOME/.cargo/bin"

# Solana / Agave CLI (also provides cargo-build-sbf, solana-test-validator)
_gb_path_prepend "\$HOME/.local/share/solana/install/active_release/bin"

# Anchor (installed and version-switched by avm)
_gb_path_prepend "\$HOME/.avm/bin"

# Node LTS via nvm. WSL interop leaks the *Windows* node/npm onto PATH
# (/mnt/c/Program Files/nodejs); nvm's entry must win, hence the prepend.
export NVM_DIR="\$HOME/.nvm"
if [ -s "\$NVM_DIR/nvm.sh" ]; then
  . "\$NVM_DIR/nvm.sh" --no-use
  _gb_nvm_default="\$(cat "\$NVM_DIR/alias/default" 2>/dev/null || echo '')"
  _gb_nvm_bin="\$(ls -d "\$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "\$_gb_nvm_bin" ] && _gb_path_prepend "\$_gb_nvm_bin"
  unset _gb_nvm_default _gb_nvm_bin
fi

export PATH

# The repo lives on /mnt/c, a 9p mount where Cargo builds are pathologically
# slow. Keep sources there but put every build artifact on WSL-native ext4.
# See docs/TOOLCHAIN.md.
export CARGO_TARGET_DIR="$CARGO_TARGET_DIR_VALUE"
EOF
info "wrote $ENV_FILE"

_gb_hook() {
  local rcfile="$1"
  touch "$rcfile"
  if grep -qF "$BASHRC_BEGIN" "$rcfile"; then
    # Remove the previous block so re-runs stay idempotent.
    awk -v b="$BASHRC_BEGIN" -v e="$BASHRC_END" '
      $0 == b { skip = 1 } skip == 0 { print } $0 == e { skip = 0 }
    ' "$rcfile" > "$rcfile.gbtmp" && mv "$rcfile.gbtmp" "$rcfile"
  fi
  cat >> "$rcfile" <<EOF
$BASHRC_BEGIN
# Managed by scripts/bootstrap-wsl.sh (ticket T00). Edit the script, not this.
[ -f "\$HOME/.greekbet-env.sh" ] && . "\$HOME/.greekbet-env.sh"
$BASHRC_END
EOF
  info "hooked $rcfile"
}
_gb_hook "$HOME/.profile"
_gb_hook "$HOME/.bashrc"

# Apply to the current (non-login) shell too, so the summary below is accurate.
# shellcheck disable=SC1090
. "$ENV_FILE"
info "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "installed versions"
{
  echo "rustc   $(rustc --version)"
  echo "cargo   $(cargo --version)"
  echo "rustup  $(rustup --version 2>/dev/null | head -1)"
  echo "solana  $(solana --version)"
  echo "anchor  $(anchor --version)"
  echo "avm     $(avm --version 2>/dev/null || echo n/a)"
  echo "node    $(node --version)"
  echo "npm     $(npm --version)"
  echo "yarn    $(yarn --version)"
} | sed 's/^/    /'

log "done — open a new WSL shell (or 'source ~/.greekbet-env.sh') to pick up PATH"
cat <<'NOTE'

    IMPORTANT — read docs/TOOLCHAIN.md before building the Anchor program.
    `anchor build` defaults to --arch v3 (sbpf v3), which solana-test-validator
    and `solana program deploy` REJECT ("Unsupported program id" / "invalid file
    header"). Always build with --arch v0:

        anchor build --arch v0
        anchor test --validator legacy --skip-build

NOTE
