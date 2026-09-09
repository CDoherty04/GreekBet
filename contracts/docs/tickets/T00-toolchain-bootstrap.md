# T00 — Toolchain bootstrap in WSL Ubuntu

**Depends on:** nothing · **Blocks:** T02, T05
**Owns:** `docs/TOOLCHAIN.md`, `scripts/bootstrap-wsl.sh`

## Context

Nothing is installed on this machine — no `rustc`, `cargo`, `rustup`, `solana`,
`anchor`, or `avm`, on Windows or inside WSL. A WSL2 Ubuntu distro exists
(currently stopped) and already has `gcc`, `cc`, `make`, `curl`, and `python3`,
with ~954 GB free. All Rust and Solana work happens **inside WSL**; native
Windows Anchor builds are not supported.

## Goal

A reproducible bootstrap that leaves WSL able to run `cargo test`,
`solana-test-validator`, and `anchor build`/`anchor test`.

## Tasks

1. Write `scripts/bootstrap-wsl.sh` — idempotent, safe to re-run:
   - `apt-get install` the Anchor/Solana build deps not already present
     (`build-essential`, `pkg-config`, `libssl-dev`, `libudev-dev`, `llvm`,
     `libclang-dev`, `protobuf-compiler`).
   - Install `rustup` + stable Rust, non-interactively.
   - Install the Solana CLI (Agave). Add it to `PATH` in `~/.bashrc`.
   - Install Node LTS (nvm or NodeSource) and `yarn` — Anchor's TS test runner
     needs them **inside WSL**; the Windows Node install is not reachable there.
   - Install `avm`, then the current stable Anchor, and `avm use` it.
2. Run it. This takes a while — that is expected, let it finish.
3. Verify and record exact versions: `rustc`, `cargo`, `solana`, `anchor`,
   `node`, `yarn`.
4. Configure Solana for local work: `solana config set --url localhost`, and
   generate a dev keypair at `~/.config/solana/id.json` if absent.
5. Smoke-test the whole chain end to end in a scratch dir **outside the repo**
   (e.g. `~/anchor-smoke`): `anchor init`, `anchor build`, `anchor test`.
   Delete it afterward. This proves the toolchain works before any ticket
   depends on it.
6. Write `docs/TOOLCHAIN.md` covering:
   - Installed versions.
   - **The invocation pattern other tickets must use.** Windows-side agents
     reach WSL via `wsl -e bash -lc '<cmd>'`. Note that PowerShell mangles
     complex quoting — the reliable pattern is to write a `.sh` file and invoke
     `wsl -e bash <path>`.
   - **`CARGO_TARGET_DIR` requirement.** The repo lives on `/mnt/c`, a 9p mount
     where Cargo builds are extremely slow. Export
     `CARGO_TARGET_DIR=$HOME/.cache/greekbet-target` so build artifacts land on
     the WSL-native ext4 filesystem while source stays on `/mnt/c`. Do the same
     for Anchor. Verify this actually works — if Anchor ignores it, document the
     real workaround you found.
   - How to convert a Windows path to a WSL path (`wslpath -a`).
   - Any deviation you had to make from the above.

## Definition of done

- `scripts/bootstrap-wsl.sh` exists, is idempotent, and ran successfully.
- `rustc`, `cargo`, `solana`, `anchor`, `node`, `yarn` all report versions in WSL.
- A throwaway `anchor init` project built **and** passed `anchor test`.
- `docs/TOOLCHAIN.md` documents versions, the invocation pattern, and the
  `CARGO_TARGET_DIR` setup.

## Report back

Exact version numbers, the verified WSL invocation pattern, whether
`CARGO_TARGET_DIR` worked, and anything that failed or needed a workaround.
