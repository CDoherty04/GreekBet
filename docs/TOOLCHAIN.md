# Toolchain (ticket T00)

All Rust and Solana work for this project happens **inside WSL2 Ubuntu**. Native
Windows Anchor builds are not supported and are not attempted anywhere.

Everything below was installed by [`scripts/bootstrap-wsl.sh`](../scripts/bootstrap-wsl.sh)
and verified end to end on 2026-09-07 (`anchor init` → `anchor build` →
`anchor test`, both the Rust/LiteSVM and the TypeScript/`solana-test-validator`
paths). Where something did not work, the real workaround is documented rather
than the intent.

---

## 0. The five things you must know

1. Reach WSL by **writing a `.sh` file and running it**, not by quoting a command
   into PowerShell. See [§3](#3-reaching-wsl-from-windows).
2. `CARGO_TARGET_DIR=$HOME/.cache/greekbet-target` is exported for every shell.
   The repo is on `/mnt/c` (9p); build artifacts must land on ext4.
   It is honoured by both `cargo` and `anchor`. See [§4](#4-cargo_target_dir).
3. **`anchor build` must be run as `anchor build --arch v0`.** The default
   (`--arch v3`) produces a binary that `solana-test-validator` and
   `solana program deploy` reject. See [§5](#5-the-arch-v0-rule-mandatory).
4. **`anchor test` must be run as `anchor test --validator legacy`.** Anchor
   1.2's default local validator is `surfpool`, which is not installed.
5. Environment lives in `~/.greekbet-env.sh`, sourced from `~/.profile` **and**
   `~/.bashrc`. Not from `~/.bashrc` alone — see [§7.2](#72-bashrc-is-dead-for-non-interactive-shells).

---

## 1. Installed versions

Verified in a login shell on 2026-09-07 (Ubuntu 24.04.3 LTS, kernel
6.6.87.2-microsoft-standard-WSL2, WSL distro `Ubuntu`, user `chite`, `HOME=/home/chite`).

| Tool | Version | Location |
|---|---|---|
| `rustc` | `1.98.1 (48a229cea 2026-09-01)` | `~/.cargo/bin/rustc` |
| `cargo` | `1.98.1 (797e8a9bc 2026-08-05)` | `~/.cargo/bin/cargo` |
| `rustup` | `1.29.1 (d95a37b6a 2026-08-13)` | `~/.cargo/bin/rustup` |
| `solana` | `solana-cli 3.1.10 (src:7bc9c805; feat:1620780344, client:Agave)` | `~/.local/share/solana/install/active_release/bin/solana` |
| `solana-test-validator` | `3.1.10` (same build) | same dir |
| `cargo-build-sbf` | `solana-cargo-build-sbf 3.1.10`, platform-tools `v1.52`, rustc `1.89.0` | same dir |
| `anchor` | `anchor-cli 1.2.0` | `~/.avm/bin/anchor` |
| `avm` | `avm 1.1.2` | `~/.avm/bin/avm` |
| `node` | `v24.20.0` (nvm LTS) | `~/.nvm/versions/node/v24.20.0/bin/node` |
| `npm` | `11.19.0` | same dir |
| `yarn` | `1.22.22` | same dir |

Apt packages installed: `build-essential`, `pkg-config`, `libssl-dev`,
`libudev-dev`, `llvm`, `libclang-dev`, `protobuf-compiler`, `ca-certificates`,
`curl`, `git`, `unzip`.

Solana CLI config: RPC `http://localhost:8899`, keypair
`~/.config/solana/id.json`, pubkey `ANX8ikrsGHQqW9wWXbYWZ4eQVL23mKrjmJGsMm1NS5R4`,
commitment `confirmed`. **Dev keypair only — never fund it with real value.**

### Version notes

- **`solana` is 3.1.10, not the latest Agave stable.** The bootstrap installs
  Agave stable from `release.anza.xyz/stable` (which was `4.2.2`), but Anchor 1.x
  manages its own Agave toolchain: the first `anchor` invocation runs
  `agave-install init 3.1.10` and re-points
  `~/.local/share/solana/install/active_release` at 3.1.10. This is intended —
  `anchor build`/`anchor test` must run against the toolchain Anchor supports.
  Do not "fix" this by re-installing a newer Agave; it will be re-pointed again.
- **Anchor is pinned to `1.2.0`** in the bootstrap script (`ANCHOR_VERSION`).
  1.2.0 is what `avm install latest` resolved to and is the version the smoke
  test passed on. Override with `GB_ANCHOR_VERSION=<ver>` to move it.
- `avm` prints a nag that 1.2.0 is available (it is 1.1.2, built from the
  `coral-xyz/anchor` git HEAD). Cosmetic; `avm` works. `avm self-update` will
  clear it if it ever matters.

---

## 2. Bootstrap

```powershell
# From the repo root, in Windows PowerShell / cmd:
wsl -u root -e bash ./scripts/bootstrap-wsl.sh
```

**Run it as root the first time.** `sudo` in this WSL install requires a
password, and `wsl -e bash` has no TTY to prompt on — but `wsl -u root` needs no
password at all. The script installs the apt packages as root and then
re-executes itself as the normal user (uid 1000) for every user-level step, so
nothing lands in root's `HOME`.

Once apt is satisfied, re-runs can go through the normal user:

```powershell
wsl -e bash ./scripts/bootstrap-wsl.sh
```

The script is idempotent — verified by a clean second run that skipped every
install step. First run takes roughly 20 minutes (mostly `cargo install avm`,
which compiles from source, ~4 min, and the Rust/Node downloads).

If the file has CRLF line endings (see [§7.5](#75-crlf-line-endings)):

```powershell
wsl -u root -e bash -c "sed 's/\r$//' ./scripts/bootstrap-wsl.sh | bash -s"
```

---

## 3. Reaching WSL from Windows

### 3.1 The rule: write a script, then run the script

Windows PowerShell 5.1 mangles anything non-trivial passed through
`wsl -e bash -lc "<cmd>"`. Observed failures during T00: `$?` silently expanded
to PowerShell's `True`; `\$p` inside a `sed` expression was eaten, producing
`sed: -e expression #1, char 16: unterminated address regex`; and long stdout
lines came back truncated.

**Do this instead:**

1. Write the script to a file with the `Write` tool (it emits LF, verified).
   Put it outside the repo — e.g. `C:\Users\chite\AppData\Local\Temp\gb-t00\x.sh`.
2. Have the script redirect its own output to a file under `/mnt/c`.
3. Run it with one dead-simple PowerShell line.
4. Read the output file with the `Read` tool.

```sh
#!/usr/bin/env bash
# C:\Users\chite\AppData\Local\Temp\gb\mytask.sh
OUT=/mnt/c/Users/chite/AppData/Local/Temp/gb/mytask.out
exec >"$OUT" 2>&1
. "$HOME/.greekbet-env.sh"          # PATH + CARGO_TARGET_DIR

cd /mnt/c/Users/chite/Downloads/projects/GreekBet/.claude/worktrees/lmsr-anchor-build
cargo test -p lmsr
echo "RC=$?"
```

```powershell
wsl -e bash -lc "bash /mnt/c/Users/chite/AppData/Local/Temp/gb/mytask.sh"
```

Then read `C:\Users\chite\AppData\Local\Temp\gb\mytask.out`.

`bash -lc "bash <path>"` is the verified invocation: the `-l` makes it a login
shell so `~/.profile` → `~/.greekbet-env.sh` runs and the toolchain is on `PATH`.
Sourcing `~/.greekbet-env.sh` explicitly inside the script (as above) makes it
robust even if someone drops the `-l`.

### 3.2 Short one-liners

For genuinely simple commands with no quotes, `$`, backslashes or redirection,
this is fine:

```powershell
wsl -e bash -lc "cargo --version"
wsl -e bash -lc "anchor --version"
```

The moment you need a quote inside a quote, a `$`, or a `>`, go back to §3.1.

### 3.3 Long-running commands

`anchor build` from cold takes ~10 minutes; `cargo install avm` ~4 minutes.
Run them in the background and poll the output file, or use a large timeout
(the tool cap is 600000 ms). Do not conclude a timeout means failure — check
the log.

### 3.4 Path conversion

```sh
wslpath -a 'C:\Users\chite\Downloads\projects\GreekBet'   # -> /mnt/c/Users/chite/Downloads/projects/GreekBet
wslpath -a 'C:/Users/chite/Downloads/projects/GreekBet'   # same (forward slashes fine)
wslpath -w /home/chite                                    # -> \\wsl.localhost\Ubuntu\home\chite
```

`wslpath` runs *inside* WSL, so it is only usable from within a script. The
worktree's fixed WSL path is:

```
/mnt/c/Users/chite/Downloads/projects/GreekBet/.claude/worktrees/lmsr-anchor-build
```

### 3.5 Root

`wsl -u root -e bash <script>` gives passwordless root. Needed only for `apt`.

---

## 4. `CARGO_TARGET_DIR`

```sh
export CARGO_TARGET_DIR="$HOME/.cache/greekbet-target"
```

Exported by `~/.greekbet-env.sh` for every shell. The repo lives on `/mnt/c`,
which WSL mounts as `v9fs` (9p) — a filesystem where Cargo's many-small-files
write pattern is pathologically slow. Sources stay on `/mnt/c`; **every build
artifact goes to WSL-native ext4**.

### Verified: it works with cargo *and* with Anchor

Anchor 1.2.0 does **not** override it. Evidence from the T00 smoke run:

- After `anchor build --arch v0` in a fresh `anchor init` project,
  `ls ./target` → `No such file or directory`. The project directory has no
  `target/` at all.
- All outputs landed under `$CARGO_TARGET_DIR`:
  `deploy/<prog>.so`, `deploy/<prog>-keypair.json`, `idl/<prog>.json`,
  `types/<prog>.ts`, `sbpf-solana-solana/release/`, `debug/`, `release/`.
- `anchor test` (both templates) found and used them with no extra config.
- Also verified for a project living **on `/mnt/c`** (`stat -f -c %T .` → `v9fs`)
  with `CARGO_TARGET_DIR` pointed at ext4: `anchor build --arch v0` took 7 s and
  `anchor test --validator legacy --skip-build` passed.
- Plain `cargo test` in a scratch crate: no `./target`, artifacts in
  `$CARGO_TARGET_DIR`.

### Consequence you must handle: `target/types` and `target/idl`

The IDL and generated TypeScript types land in `$CARGO_TARGET_DIR/{idl,types}/`,
but Anchor's generated TS tests import `../target/types/<program>`.

- The tests still **pass**, because `ts-mocha` runs transpile-only and a
  type-only import is erased. Verified.
- But `tsc`, editors, and any runtime read of `target/idl/*.json` will not find
  the files.

**`anchor build -i <dir> -t <dir>` does not fix this — it is broken in Anchor
1.2.0.** With or without pre-created directories it fails with
`Error: No such file or directory (os error 2)` (verified both ways).

**The fix that works** — a symlink in the workspace root, verified:

```sh
ln -sfn "$CARGO_TARGET_DIR" <workspace-root>/target
```

After that, `./target/idl/<prog>.json` and `./target/types/<prog>.ts` resolve
normally. **T05/T09: add `/target` to the repo's `.gitignore`** (that file is
outside T00's scope, so it has not been touched).

Note the shared target dir is genuinely shared: every crate and every scratch
project the user builds writes into it. That is fine (Cargo handles it) and is
what makes a second `anchor build` take seconds instead of minutes. It reached
4.4 GB during T00; `/` has 941 GB free.

---

## 5. The `--arch v0` rule (mandatory)

```sh
anchor build --arch v0
anchor test --validator legacy --skip-build
```

### Why

`anchor build` in Anchor 1.2.0 defaults to `--arch v3`, producing an **sbpf v3**
ELF (`readelf -h` → `Machine: Linux BPF`, `Flags: 0x3, CPU Version: 3`).
Agave 3.1.10's loader-v3 deploy path cannot load it:

- `solana program deploy` → `Error: ELF error: ELF error: Failed to parse ELF file: invalid file header`
- via `solana-test-validator` → the transaction logs
  `"Program is not deployed"` / `"failed: Unsupported program id"`

`cargo-build-sbf`'s own default is `--arch v0`; Anchor overrides it to `v3`.
Building with `--arch v0` yields `Machine: <unknown>: 0x107`, `Flags: 0x0`, which
deploys and executes correctly. Verified as a controlled A/B in the same project:
v0 → test passes, v3 → test fails with the above.

### Gotchas

- **`anchor test` has no `--arch` flag**, and `anchor test -- --arch v0` fails
  with `The argument '--arch <arch>' was provided more than once` (Anchor already
  passes its own `--arch`). So the arch must be set by a separate
  `anchor build --arch v0`, and `anchor test` must then be given `--skip-build`.
- Without `--skip-build`, `anchor test` rebuilds at `--arch v3` and breaks again.
- **A stale `deploy/*.so` will lie to you.** If a v0 `.so` is already in
  `$CARGO_TARGET_DIR/deploy/`, a subsequent v3 build may not overwrite it and a
  plain `anchor test --validator legacy` appears to pass. Observed during T00.
  Do not trust a green run that skipped `--arch v0`; wipe
  `$CARGO_TARGET_DIR/deploy` and `$CARGO_TARGET_DIR/sbpf*` when in doubt.
- There is no Anchor.toml key for the arch — `[toolchain]` only carries
  `anchor_version`, `solana_version`, `package_manager`.

If a future Anchor/Agave pairing makes sbpf v3 loadable, this rule can be
revisited — re-run the A/B in [§6](#6-smoke-test-what-was-actually-verified).

---

## 6. Smoke test: what was actually verified

Run from a login shell, fresh projects, `$CARGO_TARGET_DIR/deploy` and
`sbpf*` wiped first. All scratch projects deleted afterwards.

| # | Scenario | Result |
|---|---|---|
| A | `anchor init` (default **litesvm** Rust template) → `anchor build --arch v0` → `anchor test --skip-build` | **pass** — `test_initialize ... ok`, 1 passed |
| B | `anchor init --test-template mocha` → `anchor build --arch v0` → `anchor test --validator legacy --skip-build` | **pass** — `1 passing`, real on-chain txs against `solana-test-validator` |
| C | control: `anchor build` (default `--arch v3`) → `anchor test --validator legacy --skip-build` | **fails as expected** — `Unsupported program id` |
| D | `cargo new --lib` → `cargo test` | **pass**, no `./target` created |
| E | Same as B but with the project on `/mnt/c` (v9fs) | **pass** — build 7 s, test passed |

`anchor build` from cold: **10 min 12 s**. Warm (deps cached in the shared
`CARGO_TARGET_DIR`): **~4–22 s**.

---

## 7. Deviations and gotchas found during T00

### 7.1 `sudo` needs a password; `wsl -u root` does not

`sudo -n true` fails in this distro. `wsl -u root -e bash <script>` gives
passwordless root and is what the bootstrap uses for the apt phase. Not a
blocker.

### 7.2 `~/.bashrc` is dead for non-interactive shells

Ubuntu's stock `~/.bashrc` starts with:

```sh
case $- in *i*) ;; *) return;; esac
```

`wsl -e bash -lc '<cmd>'` — the way Windows-side tooling reaches WSL — is a
**login but non-interactive** shell. It sources `~/.profile`, which sources
`~/.bashrc`, which immediately returns. Anything appended to `~/.bashrc` never
runs. The first bootstrap attempt did exactly that and `cargo`, `node`, `anchor`
and `avm` were all "command not found".

Fix, now in the script: all environment lives in a standalone
`~/.greekbet-env.sh`, sourced from **both** `~/.profile` (login shells,
including non-interactive) and `~/.bashrc` (interactive non-login shells). PATH
entries are prepended idempotently so double-sourcing is harmless.

### 7.3 WSL interop leaks Windows `node`/`npm` onto `PATH`

Before bootstrap, `command -v npm` inside WSL resolved to
`/mnt/c/Program Files/nodejs/npm` (Windows npm, reporting `11.14.1`) while
`node` was missing entirely. A Windows Node cannot run Anchor's test runner.
`~/.greekbet-env.sh` prepends the nvm bin dir so the Linux Node wins. Always
check `command -v node` if something behaves oddly; if it starts with `/mnt/c/`,
your environment was not sourced.

### 7.4 Anchor 1.2 defaults to `surfpool`, which is not installed

`anchor test` with no flags fails immediately:
`Error: Failed to spawn 'surfpool': No such file or directory (os error 2)`.
`--validator legacy` selects `solana-test-validator` instead. Installing
surfpool was deliberately not done: T09 specifies local-validator tests, and
`--validator legacy` plus `--arch v0` was verified working.

`anchor init --test-template` options in 1.2.0: `mocha`, `jest`, `rust`,
`mollusk`, `litesvm` (default `litesvm`). `--package-manager`: `npm`, `yarn`,
`pnpm`, `bun` (auto-detect cascade `pnpm` → `yarn` → `npm`). Pass
`--package-manager yarn` explicitly to get `yarn`.

### 7.5 CRLF line endings

This repo has `core.autocrlf=true` and no `.gitattributes`. Git will hand out
CRLF `.sh` files on checkout, and `bash` fails on them
(`$'\r': command not found`). `scripts/bootstrap-wsl.sh` is written with LF in
the working tree, so it works now, but a fresh clone on Windows will break it.

**Recommended (outside T00's file scope):** add a `.gitattributes` with

```
*.sh text eol=lf
```

Until then, the CR-tolerant invocation is:

```powershell
wsl -u root -e bash -c "sed 's/\r$//' ./scripts/bootstrap-wsl.sh | bash -s"
```

### 7.6 Anchor's litesvm template and sbpf v3

The default `anchor init` (litesvm) test failed out of the box with
`Instruction(InvalidAccountData)` at `svm.add_program(...)`. Same root cause as
[§5](#5-the-arch-v0-rule-mandatory) — it passes once built with `--arch v0`.

---

## 8. Quick reference

```sh
# Source the environment (any script should do this defensively)
. "$HOME/.greekbet-env.sh"

# Pure-Rust crates (T02-T04)
cd /mnt/c/.../lmsr-anchor-build
cargo test -p lmsr

# Anchor program (T05+)
anchor build --arch v0
anchor test --validator legacy --skip-build

# Types/IDL where TS expects them (once, per workspace)
ln -sfn "$CARGO_TARGET_DIR" ./target

# Local validator by hand
solana-test-validator --reset --ledger /tmp/gb-ledger
solana --url http://127.0.0.1:8899 airdrop 100
```

```powershell
# From Windows: write a .sh, then
wsl -e bash -lc "bash /mnt/c/<path-to>/task.sh"
# and read the output file the script redirected to.
```
