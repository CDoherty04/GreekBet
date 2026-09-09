# T10 — Devnet deploy and real-USDC integration pass

**Depends on:** T09 · **Blocks:** nothing (final ticket)
**Owns:** `scripts/devnet/`, `docs/DEVNET.md`, `tests/devnet/`

## Context

Plan §3 and §4.2 (second half). This ticket satisfies the third exit criterion:
*"The same lifecycle has been run successfully at least once on devnet with real
devnet USDC transfers."*

`docs/DESIGN_DECISIONS.md` D3: devnet uses Circle's devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

**This ticket touches an external network.** Devnet only — no mainnet, no real
funds, ever. Stop and report rather than improvising if anything pushes toward
mainnet.

## Tasks

1. `scripts/devnet/setup.sh` — `solana config set --url devnet`, ensure a
   deploy keypair exists, request a SOL airdrop with retry (the devnet faucet is
   rate-limited and flaky; back off rather than hammering it), report the balance.
2. `scripts/devnet/deploy.sh` — **`anchor build --arch v0`** then
   `anchor deploy --provider.cluster devnet`. Keep upgrade authority as the local
   keypair (plan §3 — fast iteration, no lockdown yet). Record the deployed
   program ID and sync it into `Anchor.toml` and `declare_id!`.
   - **`--arch v0` is not optional.** T00 verified that Anchor 1.2.0's default
     sbpf v3 output is rejected outright — `solana program deploy` fails with
     `invalid file header`. Devnet runs the same Agave line, so a v3 artifact
     will not deploy there either.
   - Wipe `deploy/` first. A stale v0 `.so` can make a broken build look fine.
   - The local dev keypair from T00 is
     `ANX8ikrsGHQqW9wWXbYWZ4eQVL23mKrjmJGsMm1NS5R4` at
     `~/.config/solana/id.json`. T00 left `solana config` pointing at
     **localhost** — your setup script must switch it to devnet, and should
     switch it back or leave a note, since T09's local tests depend on it.
   - **Report the program ID prominently.** The user needs it.
3. **Funding test wallets with USDC — plan §3 wants this unattended.** Circle's
   devnet USDC faucet cannot be minted by us, so try, in order:
   a. Circle's devnet faucet API, if reachable and scriptable.
   b. Transfer from an already-funded wallet the user tops up once.
   c. Fall back to a custom mint, which plan §3 explicitly permits *"if the
      faucet is unreliable during development."*
   Whichever path works, script it as `scripts/devnet/fund.ts` and **document
   which one you used**. If the only unattended path is (c), say so plainly —
   the exit criterion is then partially met and the user must know.
4. `tests/devnet/lifecycle.ts` — the T09 lifecycle against devnet, adapted for
   real network conditions:
   - Confirmation commitment and generous timeouts; devnet is slow.
   - Retry on blockhash expiry / transient RPC failure.
   - Short `close_time` (there is no clock warp on devnet — pick a real wait of
     a minute or two and actually wait it).
   - The full path: create → buy (multiple users) → sell → close → resolve →
     redeem, with real USDC transfers.
   - Resolver access control verified on devnet too — it is a named exit
     criterion (plan §4.3).
5. Run it. Capture real transaction signatures for every lifecycle step.
6. `docs/DEVNET.md`:
   - Program ID, cluster, mint address actually used.
   - How to redeploy from scratch.
   - How to fund a fresh test wallet.
   - **Transaction signatures from the successful run**, with explorer links —
     this is the evidence the exit criterion was met.
   - Anything that behaved differently on devnet than on the local validator
     (plan §4.2's whole reason for this pass). Compute-unit differences, rent,
     timing, RPC quirks.
7. Update `docs/tickets/README.md` — mark all tickets done — and write
   `docs/STATUS.md` assessing each of the four exit criteria in plan §4.3 as
   met / partially met / not met, with evidence.

## Definition of done

- Program deployed to devnet, ID recorded.
- Full lifecycle run **successfully at least once** on devnet with real USDC
  transfers, transaction signatures captured.
- Resolver access control verified on devnet.
- `docs/DEVNET.md` and `docs/STATUS.md` written.

## Report back

Program ID, the funding path that worked, transaction signatures for the
lifecycle run, every local-vs-devnet behavioral difference, and an honest
assessment of each exit criterion. If something could not be completed —
faucet unavailable, airdrop rate-limited — **say so explicitly**; do not report
this ticket as done on a partial run.
