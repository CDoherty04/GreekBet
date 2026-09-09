# Devnet deployment and integration pass (ticket T10)

**Devnet only. No mainnet, no real funds, ever.** The deploy keypair is a
throwaway dev key; the "USDC" below is Circle's *devnet* mint, which has no
value.

Everything in this document was executed on **2026-09-09** and the transaction
signatures are real and on chain. Where something did not work, the failure is
written down rather than the intent.

---

## 1. What is deployed

| | |
|---|---|
| **Program ID** | `GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ` |
| Cluster | devnet, `https://api.devnet.solana.com` (`solana cluster-version` → `4.3.0-rc.0`) |
| ProgramData | `4NVrL4PqVxCcNhvcSoc9Q5sJHME38GwKgLR6XRbDEFid` |
| Upgrade authority | `ANX8ikrsGHQqW9wWXbYWZ4eQVL23mKrjmJGsMm1NS5R4` (the local dev keypair — plan §3 keeps it unlocked for fast iteration) |
| Deploy slot | 495721379 |
| Deploy transaction | [`4zhjUjwBPPnrjBAkBuLpmXAfSATtggW3CcvNF5xHJftR8LTa5jnCwtb8TGkeyweXfnqhJGsxWvKWczj6eWNFBQC5`](https://explorer.solana.com/tx/4zhjUjwBPPnrjBAkBuLpmXAfSATtggW3CcvNF5xHJftR8LTa5jnCwtb8TGkeyweXfnqhJGsxWvKWczj6eWNFBQC5?cluster=devnet) |
| Binary | 327,824 bytes, sbpf **v0** (`readelf -h` → `Machine: <unknown>: 0x107`, `Flags: 0x0`) |
| Rent paid | 1.66622476 SOL on the programdata account |
| Explorer | <https://explorer.solana.com/address/GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ?cluster=devnet> |

The program ID matches `declare_id!` in `programs/greekbet/src/lib.rs` and both
`[programs.localnet]` and `[programs.devnet]` in `Anchor.toml`.

### Collateral mint actually used

**Circle's devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`** — the
mint `docs/DESIGN_DECISIONS.md` D3 specifies. 6 decimals, mint authority
`GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz` (Circle's; we cannot mint it),
freeze authority `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`.

The funding path that got it there is **(b), transfer from a treasury the user
topped up once by hand.** See [§3](#3-funding-usdc-what-worked-and-what-did-not)
— path (a), the faucet API, is not scriptable, and the custom-mint fallback (c)
is implemented and was used for the first run but is *not* what the recorded
lifecycle below ran on.

---

## 2. Running it

All commands run **inside WSL**, from `contracts/`, with the environment sourced
(`. "$HOME/.greekbet-env.sh"`). See `docs/TOOLCHAIN.md` §3 for the
write-a-script-then-run-it pattern; inline PowerShell quoting mangles these.

```sh
bash scripts/devnet/setup.sh          # point the CLI at devnet, verify keys and balance
bash scripts/devnet/deploy.sh         # anchor build --arch v0, then anchor deploy
bash scripts/devnet/run-lifecycle.sh  # fund.ts, then tests/devnet/lifecycle.ts
bash scripts/devnet/setup.sh --restore  # put the CLI back on localhost for T09
```

`run-lifecycle.sh` runs `scripts/devnet/fund.ts` first (idempotent — it reuses
persisted wallets and tops them up only when short), then mocha over
`tests/devnet/lifecycle.ts` alone.

### Redeploying from scratch

`deploy.sh` does the whole thing, but the two traps it guards are worth stating
because both have already bitten this project:

1. **`anchor build --arch v0` is mandatory.** Anchor 1.2.0 defaults to sbpf v3,
   which Agave rejects at load: `solana program deploy` fails with
   `ELF error: ... invalid file header`. Devnet runs the same Agave line, so
   this is not a local-validator quirk. `deploy.sh` wipes the stale `.so` first
   (a leftover v0 artifact makes a broken v3 build look fine) and prints the ELF
   header so you can see which arch you got.

2. **The program keypair is not in the repo and a build silently replaces it.**
   It lives at `$CARGO_TARGET_DIR/deploy/greekbet-keypair.json`
   (`~/.cache/greekbet-target/...`), it is gitignored, and if it is missing
   `anchor build` generates a **new** one — which mints a new program ID and
   orphans the 1.67 SOL already spent on the deployed one.

   This was not hypothetical. When T10 started, that file held
   `4M7TNCJ2ccrzF3D7uufuM1WYb6d2Xjvij8hnfwypZTsq` while `declare_id!` said
   `GRUTmt…`; a build after some earlier wipe had regenerated it. It was
   restored from a backup before deploying. `deploy.sh` now refuses to run on a
   mismatch and copies the keypair to
   `~/.greekbet-devnet/keypair-backups/` on every deploy. **Back that directory
   up somewhere outside `~/.cache`.**

Redeploying to the *same* program ID reuses the existing programdata account and
costs only fees (~0.001 SOL), so iteration after the first deploy is cheap. A
*new* program ID costs another ~1.67 SOL.

### Funding a fresh test wallet

`scripts/devnet/fund.ts` does it. It persists keypairs under
`~/.greekbet-devnet/wallets/` and writes a manifest to
`~/.greekbet-devnet/funding.json` that the test reads. To start over, delete
that directory and re-run.

* **SOL** comes from a `SystemProgram.transfer` out of the treasury wallet, not
  from an airdrop — see §3. 0.05 SOL per wallet, which is ~7x the worst-case
  rent it has to pay (the treasury is the fee payer for every instruction; a
  role wallet only pays rent for accounts where Anchor names *it* as `payer` —
  `market` + `vault` for the creator, `position` for a trader).
* **USDC** is transferred from the treasury's ATA with `transfer_checked`.

To top the treasury up:

* SOL — <https://faucet.solana.com>, paste
  `ANX8ikrsGHQqW9wWXbYWZ4eQVL23mKrjmJGsMm1NS5R4`. Captcha-gated; not scriptable.
* USDC — <https://faucet.circle.com>, choose **Solana Devnet**, paste the same
  address. **10 USDC per drip; the fixture needs 15, so drip twice.**

---

## 3. Funding USDC: what worked and what did not

The ticket asks for three paths, in order. All three were implemented in
`scripts/devnet/fund.ts`; here is what each one actually did.

### (a) Circle's devnet faucet API — **does not work unattended**

`https://faucet.circle.com/api/graphql` is a live Apollo endpoint. Introspection
is disabled (`INTROSPECTION_DISABLED`), but the server's own "did you mean"
validation errors give up the whole shape:

```graphql
mutation ($input: RequestTokenInput!) { requestToken(input: $input) { __typename } }

input RequestTokenInput {
  destinationAddress: String!
  blockchain: Blockchain!   # SOL
  token: Currency!          # USDC
}
```

Sent with a correct payload it returns **HTTP 200** and:

```json
{"errors":[{"message":"ReCAPTCHA verification failed",
            "path":["requestToken"],
            "extensions":{"code":"RECAPTCHA_ERROR"}}],"data":null}
```

The faucet's own client config confirms this is not a transient:
`faucetEnabled: true`, `solanaSupportEnabled: true`, but `recaptchaEnabled: true`
with `reCaptchaThreshold: 0.7` and a reCAPTCHA **v3** site key
(`6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2`). A v3 token can only be produced by
a real browser session that Google scores. **No script can drip Circle USDC.**

The documented REST route needs a Circle developer API key:

```
POST https://api.circle.com/v1/faucet/drips
-> 401 {"code":401,"message":"malformed authorization. Missing API key in
        authorization header. Make sure to use Bearer authorization type"}
```

`fund.ts` still attempts both on every run — set `CIRCLE_API_KEY` and it will use
the REST route, and if Circle ever drops the captcha the GraphQL route starts
working with no other change. Neither failure is treated as an error.

### (b) Transfer from a topped-up treasury — **this is what the recorded run used**

The user dripped **20 USDC** into
`ANX8ikrsGHQqW9wWXbYWZ4eQVL23mKrjmJGsMm1NS5R4` through the web faucet.
`fund.ts` then distributed it with `transfer_checked` and the lifecycle ran on
the real Circle mint. One manual action, then everything downstream is scripted.

Because a drip is only 10 USDC, the Circle fixture is **scaled down**: `b` is
`B_MIN` (10 USDC) rather than 100, and the three buys are 1.0 / 0.4 / 2.0 USDC
rather than 10 / 4 / 20. Total requirement 15 USDC. This is the `SCALES` table
in `fund.ts`; the manifest records which scale ran and the test reads `b` and the
spends from it, so nothing is hardcoded in two places.

### (c) Custom 6-decimal mint — **implemented, and the unattended fallback**

Plan §3 permits it explicitly ("A custom dummy token is an acceptable fallback if
the faucet is unreliable during development"), and D3 already uses one for the
local suite. `fund.ts` creates/reuses `5XWYAVBaM34pJx5LT9pNS8TdVJAb8ieHzqD9twZZ7zaG`
(mint authority = treasury) whenever the treasury has no Circle USDC.

The **first** devnet lifecycle run used this mint. It passed 11/11 and its
numbers are recorded in §5 for the compute-unit comparison, but it is **not**
real USDC and on its own it would have left the exit criterion only partially
met. It is kept as the path that works with zero manual steps.

Force a path with `GB_COLLATERAL=circle` or `GB_COLLATERAL=custom`. Forcing
`circle` with an under-funded treasury fails loudly rather than silently falling
back:

```
Error: GB_COLLATERAL=circle was forced but the treasury holds 5 USDC and the
fixture needs 15. Circle's faucet gives 10 USDC per drip: open
https://faucet.circle.com, choose Solana Devnet, paste ANX8ikrs…, drip twice,
then re-run.
```

### SOL: the airdrop does not work either

`solana airdrop` and `connection.requestAirdrop` against
`api.devnet.solana.com` failed on **every** attempt from this host:

```
Requesting airdrop of 1 SOL
Error: airdrop request failed. This can happen when the rate limit is reached.
```

The limiter is per source IP and is a spent quota, not a transient, so **neither
`setup.sh` nor `fund.ts` contains a retry loop** — a loop would only turn a fast
failure into a slow one. Both ask at most once (`setup.sh` only if
`GB_TRY_AIRDROP=1`) and then tell the operator to use the web faucet. The
treasury was funded manually by the user; test wallets are funded by transfer
from it.

---

## 4. The successful lifecycle run — real Circle devnet USDC

`create → buy ×3 → sell → close → resolve → redeem`, plus slippage and resolver
access control. **11 passing.**

* Collateral: **Circle devnet USDC** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
* Market PDA: `ASLXx7YqejsLNqjEFCu5tsQ92w9hdz9t6ekPD3Zo9H9R`
* Vault PDA: `5uoCeLAiSTTV46GKdEW2rLERzwNqvLmbkWuUQLT239tX`
* Creator: `BHBoJFyZyVggJzGj4ERjA1cNhLpyjLXpsqarsqsq6vMg`
* Resolver: `47WmzNoy8c2mPmG65coP8XhASFUaHyMpn887sEHH7atP`
* `b` = 10,000,000 (10 USDC); `close_time` window 120 s of real wall clock
* Full record: `~/.greekbet-devnet/lifecycle-run.json`

| Step | Signature | Slot | CU |
|---|---|---|---|
| `create_market` | [`2JebBUAZ…HegwGXeM`](https://explorer.solana.com/tx/2JebBUAZZgXWMcKGtihgCoTVCDW4zckQaweqEVmhZsDfznUDdhkZk1EeGWGL222hT2tmUdHMQT2TsxM9HegwGXeM?cluster=devnet) | 495729871 | 26,023 |
| `buy_shares` A YES 1.0 USDC (inits position) | [`3XLcFrfb…Cdu4kHq3`](https://explorer.solana.com/tx/3XLcFrfbCoQPasUJR8QQYvrrJJTbHA4PVBarAoMPbiHWmrVRR2Npf26aBwVsjABtTASWPZXcsVC4XCjECdu4kHq3?cluster=devnet) | 495729880 | 49,878 |
| `buy_shares` B NO 0.4 USDC | [`cVhQh4Wx…1W3YnQQS`](https://explorer.solana.com/tx/cVhQh4WxnVrM5J9fKeYg8TYTPzrNKK8nEwqCq5BdjWVrqG6RiaQWs1bZ5jiHgUTEBB6YiJt8jqFsn1D1W3YnQQS?cluster=devnet) | 495729887 | 56,848 |
| `buy_shares` C YES 2.0 USDC | [`3kwRGUwi…PLdQ73Pd`](https://explorer.solana.com/tx/3kwRGUwidj95j77Vv3nWkdt6TfNAeZDUVUALvpttbUfs6kmTCwtPendLNhifmeYVDAURqLU3Hc6CUpryPLdQ73Pd?cluster=devnet) | 495729947 | 59,788 |
| `sell_shares` A, half of YES | [`5GMkarkh…A9qNheMu`](https://explorer.solana.com/tx/5GMkarkhAossJbz1dtGDEtECu8VcN6Ch5JUciRhFJM51jcGrXYKsyotS58eANe4GNQWnsJU1H4vDaVPRA9qNheMu?cluster=devnet) | 495729959 | 56,542 |
| `close_market` | [`3KoEbzQt…N2hJs2dR`](https://explorer.solana.com/tx/3KoEbzQtFWMwoSe92wXGZR6GyB9j8fNgbpUyf4PD6y8nZM7M6yp85E3XEEbSUh3HkzJCYf4EotrYBLu1N2hJs2dR?cluster=devnet) | 495730607 | 4,767 |
| `resolve_market` YES | [`4ZFsTUMn…MEFJA2eC`](https://explorer.solana.com/tx/4ZFsTUMn7ShVeZ5MWnPMTzECB5v8AGf5YxQY9WuKDXMbXShWDARzu1ydznx8Rrwpr8QeD6Qgh6CxATNmMEFJA2eC?cluster=devnet) | 495730615 | 5,190 |
| `redeem` A (winner) | [`2DMvUCK7…4UBcRT52`](https://explorer.solana.com/tx/2DMvUCK7hfRQj5ks9nKT756UweXqDJErPdDFUfuFqiCrHYwpnMQ3hEy2iunmWNLiYy5Sss3jh3npdeXq4UBcRT52?cluster=devnet) | 495730622 | 10,889 |
| `redeem` C (winner) | [`2ud5JrRc…ryqp1Xs7`](https://explorer.solana.com/tx/2ud5JrRcFg5ZAAkuBBupuANRierzPhE3ZLH8AUz7YGRrqVhYEFoSMoFmELgFAz6njwto5Esz3CgMaAE9ryqp1Xs7?cluster=devnet) | 495730680 | 10,889 |
| `redeem` B (loser, paid 0) | [`5t48nfRV…LAAAfa3L`](https://explorer.solana.com/tx/5t48nfRVdHLsSxJxvnrs8qda55gmCB18Fj1forUf5JHf5qs7Vs2Vbe4oTu7ZHmdTg6ZoqRmYYi6k6pizLAAAfa3L?cluster=devnet) | 495730685 | 9,087 |

USDC distribution to the test wallets (also real Circle USDC,
`transfer_checked`):

| To | Amount | Signature |
|---|---|---|
| creator | 7.5 USDC | [`2QQMUe9x…SRZAgXoy`](https://explorer.solana.com/tx/2QQMUe9xVBDDDsSuL3exTvDb7SS3hGgdFGQ41pdZytDqAxE3PemXJhm7xrqD1bWZgjj8z71B6nHkDdXRSRZAgXoy?cluster=devnet) |
| traderA | 2.5 USDC | [`4wtRfcTn…ma2U5r7tW`](https://explorer.solana.com/tx/4wtRfcTntHoasV64MostXCEmGg2cYKstNP9jJE1625yEmnpwSedZbZJAJo3UZTDBW7CbYnDvU9xmA2wma2U5r7tW?cluster=devnet) |
| traderB | 2.5 USDC | [`4BFRWxdo…VctGcK7X`](https://explorer.solana.com/tx/4BFRWxdo2KoABfpk878ytp4VHD8pWd4HbcWucVbwAWx4rnu51TZ8YveAd78PNUsTPyVsP3pCuJ8RFnFUVctGcK7X?cluster=devnet) |
| traderC | 2.5 USDC | [`51n5vNLi…S6SQmwpK`](https://explorer.solana.com/tx/51n5vNLihYQAviCfVDv1NNmKCfkeMVosYMSmWz6Bab2mFRvxqwuetkWpNUMTHt86uNBDQ4CGmTmkb8CuS6SQmwpK?cluster=devnet) |

Vault accounting (base units, 1e-6 USDC), all asserted with **zero tolerance**:

```
b                   = 10000000
seed (b·ln2)        = 6931471        # == floor(10e6 · ln2), computed on chain
collateral in       = 3400000
collateral out      = 5040205
  of which payouts  = 4466922
q_yes at resolution = 4466922        # payouts == q_yes exactly (winners paid 1:1)
q_no  at resolution =  863664
RESIDUAL in vault   = 5291266        # == seed + in − out, and ≤ seed
```

Also verified on chain in the same run, not only locally:

* **Resolver access control** (plan §4.3's fourth criterion). A stranger (the
  treasury) and the market creator both get `Unauthorized` (6006), and the
  market is still `Closed` afterwards. `resolve_market` enforces this with
  `has_one = resolver`, an *account constraint*, so it is checked in
  `try_accounts` before any status check — which is why the error is
  `Unauthorized` rather than a status error.
* **Slippage.** A buy with an unreachable `min_shares_out` reverts
  `SlippageExceeded` (6009) and `q_yes` is still 0.
* **`close_market` before `close_time`** reverts `CloseTimeNotReached` (6004).
* **A second `redeem`** fails `AccountNotInitialized` (3012), not
  `NothingToRedeem` — `redeem` carries `close = owner`, so the account is gone.
* Every instruction fits the **200,000 CU default**; nothing raises the budget.

### The earlier custom-mint run (kept for the CU comparison)

Same 11 tests, same program, mint `5XWYAVBaM34pJx5LT9pNS8TdVJAb8ieHzqD9twZZ7zaG`,
at `b` = 100 USDC so it matches `tests/lifecycle.ts` exactly:
[`2TLvcwx2…pWN84CufE` (create)](https://explorer.solana.com/tx/2TLvcwx2PAAcmyFgsorHwwx88CpPYsirieuxfUZngvWD8vNEWyXL4ByGJidWyPaBBSPW8K251YQ5vG9pWN84CufE?cluster=devnet),
[`226dgAvt…D1AYNJDR` (buy A)](https://explorer.solana.com/tx/226dgAvt8ZZuCpYRqu5oaeddf7Ed7YKXgyon73HX8VJmT9HbLkpe3CHntntRVmCdyM3GNJZY7ucmWQ72D1AYNJDR?cluster=devnet),
[`3EdVaXjN…Abf1s8a8` (buy B)](https://explorer.solana.com/tx/3EdVaXjN3DfLpfZmEygcg8aQPrAisyDTWSgGNHfPW1h4FJTsWqVHQeyFt4nurSYtXsd2sjFNmDVWbvZjAbf1s8a8?cluster=devnet),
[`4AWxNY5L…rmUJ7Dux` (buy C)](https://explorer.solana.com/tx/4AWxNY5LvBJZpZBi9iwhWVhaGPZznTm1X8RY3UPqBdCuJfyiEa8JeRCjtuxoGq2XYNsEFcbaWEawkH7prmUJ7Dux?cluster=devnet),
[`4uR3cx85…WMv6mEG3` (sell)](https://explorer.solana.com/tx/4uR3cx85mQJPoWouSCZDeWgppXmPHwcZtMcaXBK6VyhxUjNPbPbbh2JkMwn6rwwVSCn53ERpFRho2QSnWMv6mEG3?cluster=devnet),
[`3rVfHbk9…HUhyqnJQ` (close)](https://explorer.solana.com/tx/3rVfHbk9fWJX4VSMxWThEiStDUzYCZMxqJU4rXhRuKeDd65sQN4JDaPbzhYYRZ5EPqPyr3EprnC18xdyHUhyqnJQ?cluster=devnet),
[`48dm6idv…bNkbV7RR` (resolve)](https://explorer.solana.com/tx/48dm6idvQker3U85W9X7FnqSZqGdQ373sbQY9kyVxseRR2K9gGVpgZPS3iEg2yWU7HSJDDUtvtnZnzMMbNkbV7RR?cluster=devnet),
[`2xUysXN3…x9TfZR3S`](https://explorer.solana.com/tx/2xUysXN3aQKfWQzbVJcCgZnJxB4amynd6drckuAjUdMcwNSY3bMnBtdpk3eVndXGsvGsSGEM2s7qFn1cx9TfZR3S?cluster=devnet) /
[`mL86FED1…C3SuSnU`](https://explorer.solana.com/tx/mL86FED18QXVLyTWrMJJaEzJ2JGLhaFATzpr4Yb4kVoxgoHE2STd6HisdermGaRn7NGZeTMYTxKgw7hLC3SuSnU?cluster=devnet) /
[`5pjoXt7D…CBThKbas`](https://explorer.solana.com/tx/5pjoXt7DVtds2NbGD9S7VVXRzdbeJZnySogruF2Rp3tCjYavShHmYRCY92WReYjHiUZufGaNhFcV2TkFCBThKbas?cluster=devnet) (redeems).

Market `8n7XdRHay1q3ioM68K4oPY38c9p8AZ47hvcLLYAEwMX5`, vault
`7FTaKFWjw6HhvuHeRQhCs3kcdxvyEj1ey84QkenZFW69`.

---

## 5. What behaved differently from the local validator

This is the reason plan §4.2 asks for the pass at all. Local =
`solana-test-validator` 3.1.10 (the toolchain Anchor 1.2 pins); devnet =
Agave **4.3.0-rc.0**.

### 5.1 Compute units: SPL Token CPIs are ~4,500 CU cheaper on devnet

The custom-mint devnet run used *identical* parameters to `tests/lifecycle.ts`
(`b` = 100 USDC, buys of 10 / 4 / 20), so these are directly comparable.

| Instruction | Local 3.1.10 | Devnet 4.3.0-rc.0 | Δ | Token CPIs |
|---|---:|---:|---:|---:|
| `create_market` | 39,074 | 26,016 | **−13,058** | 2 |
| `buy_shares` (first buy, inits position) | 54,465 | 49,901 | **−4,564** | 1 |
| `sell_shares` | 61,107 | 56,543 | **−4,564** | 1 |
| `redeem` (winner, pays out) | 15,453 | 10,889 | **−4,564** | 1 |
| `redeem` (loser, no transfer) | 9,082 | 9,087 | **+5** | 0 |
| `close_market` | 4,762 | 4,767 | **+5** | 0 |
| `resolve_market` | 5,185 | 5,190 | **+5** | 0 |

The pattern is exact: **every instruction with no CPI costs +5 CU on devnet, and
every SPL Token CPI costs about 4,564 CU less.** The devnet logs show the token
program itself consuming almost nothing:

```
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 76 of 164513 compute units
```

76 CU for a `transfer_checked`; 233 and 105 for the two CPIs inside
`create_market`. That is the CPI metering of the newer Agave line, not anything
about our program.

**Consequence: the local numbers are the conservative ones.** Every instruction
was already comfortably inside the 200,000 CU default locally, and devnet is
cheaper still for everything that touches the token program. Nothing needs
`ComputeBudgetProgram.setComputeUnitLimit`. Do **not** invert this and start
budgeting against the devnet numbers — a validator version change could hand
back the 4,500 CU.

### 5.2 The arithmetic is bit-identical across validator versions

The custom-mint devnet run and the local run produced *exactly* the same
numbers from the same inputs:

```
q_yes at resolution = 44669228     payouts  = 44669228
q_no  at resolution =  8636645     residual = 52912657
```

And the Circle run at `b` = 10 (one tenth the scale) produced
`q_yes = 4466922`, `q_no = 863664`, `residual = 5291266` — the same values
scaled by 10 with the expected floor (`44669228 / 10 = 4466922.8 → 4466922`).
The Q64.64 fixed-point LMSR is deterministic across Agave 3.1.10 and 4.3.0-rc.0
and across two orders of magnitude of `b`.

### 5.3 The public RPC rate-limits aggressively

`429 Too Many Requests` from `api.devnet.solana.com` appeared **in every run**,
in bursts of 4-8 consecutive rejections, under a load the local validator would
not notice. web3.js retries some of it internally; the rest is handled by
`withRetry` in `fund.ts` and by the `send()` wrapper in the devnet test. Two
specific things:

* `getTokenLargestAccounts` is refused outright with a *different* message —
  `{"code":429,"message":"Too many requests for a specific RPC call"}` — i.e.
  some methods are individually restricted on the public endpoint regardless of
  your general rate.
* A freshly confirmed signature can 404 from `getTransaction` for a second or
  two, because the node answering the read is not the one that confirmed the
  write. The local suite polls for 5 s; the devnet test polls for 60 s with
  exponential backoff.

If this becomes painful, use a dedicated RPC (Helius/QuickNode/Triton) by
setting `ANCHOR_PROVIDER_URL`.

### 5.4 Confirmation latency and slot time

* Local: an instruction round-trips in **40-500 ms**.
* Devnet: **600-2,000 ms** typically, up to **9,000 ms** when a 429 burst forced
  backoff. Devnet slots are ~400-600 ms.

This is why the devnet test pins commitment to `confirmed` everywhere and never
reads state without going through a retry wrapper. `AnchorProvider.env()`'s
default of `processed` is a rare flake locally and a routine wrong answer here.

It is also why `send()` does **not** naively retry. When
`confirmTransaction` throws `TransactionExpiredBlockheightExceededError`, that
says nothing about whether the transaction landed — it frequently has. The
wrapper checks `getSignatureStatus` before rebuilding; re-signing a
`buy_shares` against a fresh blockhash would apply it twice.

### 5.5 No clock warp, and the wait is real

Same as the local validator in kind, much worse in degree. `tests/lifecycle.ts`
uses a 20 s `close_time` window and waits ~18 s. The devnet test uses 120 s and
waits ~100 s of genuine wall clock, polling the `Clock` sysvar at 2 s (not the
local suite's 500 ms — a tighter poll just draws 429s and buys no precision
against a 400-600 ms slot). Whole-suite time: **~25 s locally, ~2 min on
devnet.**

The `Clock` sysvar, not `Date.now()`, is the value the program compares
`close_time` against, and on devnet it is a cluster consensus value that does
drift from the host clock.

### 5.6 `anchor deploy` fails after successfully deploying the program

Anchor 1.2.0 does two things under one command: it deploys the `.so`, then it
uploads the IDL into a program-metadata account (program
`ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, seed `idl`). The second half
failed on devnet:

```
Deploying program "greekbet"...
Program ID: GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ
Writing metadata account...
 ├─ metadata: GEWsmCDD5aPLoe3RKn3wetxFApWPAD715Wd8rFHWgHP6
[Error] The provided transaction plan failed to execute. See the
        `transactionPlanResult` attribute for more details.
Error: Failed to initialize IDL
```

`anchor deploy` exited **1** while `solana program show` reported the program
deployed, executable, 327,824 bytes, at the right address. The program half is
fine; only the IDL half failed.

**The on-chain IDL is truncated, not merely unfinalized.** Measured rather than
inferred — the metadata account was fetched, its zlib stream located and
inflated:

```
metadata account raw length : 7702 bytes      (0.0480822 SOL of rent, already paid)
zlib stream at offset       : 96
inflated length             : 37074 bytes
stream reached EOF          : False           <-- the compressed stream is incomplete
local target/idl/greekbet.json : 48178 bytes
JSON parse                  : FAILS — "Unterminated string ... (char 37007)"
```

What did land is correct as far as it goes — it starts
`{"address": "GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ", "metadata": {"name":
"greekbet", ...}` — but roughly the last quarter of the document is missing and
it cuts off mid-string inside an event doc comment. Anchor writes the IDL in
chunks across several transactions; some of the later chunks never landed, which
is consistent with the 429 bursts everything else on devnet hit. `anchor idl
fetch` returns raw hex rather than JSON for exactly this reason.

**Nothing in this repo reads it**, so this is not on any critical path here:
`anchor.workspace` and `tests/devnet/lifecycle.ts` both load
`$CARGO_TARGET_DIR/idl/greekbet.json` from disk. `deploy.sh` therefore no longer
trusts anchor's exit code — it verifies the *program* on chain and only fails if
that is missing, because treating this as fatal would mean redeploying a live
program at 1.67 SOL a go.

It **will** matter to anyone holding only the program address: explorers decode
instructions, accounts and events from the on-chain IDL, and any third-party
client doing `Program.at(programId, provider)` or `anchor idl fetch` needs it.
Until it is repaired, devnet transactions render as raw bytes in Solana
Explorer and an external integrator has to be handed the JSON out of band.

To repair it — note the account already exists and is partly written, so
`anchor idl init` will likely reject it as already initialised; the upgrade path
writes to a buffer and swaps, which is also what survives a chunk failure:

```sh
anchor idl upgrade --provider.cluster devnet \
  --filepath "$CARGO_TARGET_DIR/idl/greekbet.json" \
  GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ

# verify — this must print JSON, not hex:
anchor idl fetch --provider.cluster devnet \
  GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ | head -c 200
```

Not attempted during T10: it costs SOL, nothing in this phase depends on it, and
a failed retry against a half-written account is a worse state than the current
one. Budget a little SOL and verify the fetch actually round-trips.

### 5.7 Rent is real money here

| Account | Size | Rent |
|---|---:|---:|
| programdata | 655,648 B (2× the `.so`) | 1.66622476 SOL |
| Anchor IDL metadata | 7,702 B | 0.0480822 SOL |
| `Market` | 417 B | 0.0027686 SOL |
| `UserPosition` | 89 B | ~0.0015 SOL (refunded — `redeem` closes it) |
| vault / ATA | 165 B | ~0.00204 SOL |

Locally this is invisible because the validator airdrops on demand. Here the
first deploy is a third of a 5 SOL budget, and there is no airdrop to top it
back up. Redeploys to the same ID are ~0.001 SOL. **Budget before deploying.**

### 5.8 `solana config` is global state and the local suite depends on it

T00 left the CLI on `http://localhost:8899` and T09's suite assumes that.
`setup.sh` saves the previous URL to `~/.greekbet-devnet/previous-cluster`
before switching and `setup.sh --restore` puts it back. Everything else under
`scripts/devnet/` passes `--url` / `ANCHOR_PROVIDER_URL` explicitly, so no step
actually depends on the ambient config. **The CLI was left pointing at
localhost.**

### 5.9 Things that behaved identically

Worth stating, because "no difference" is also a finding:

* Every error code. `Unauthorized` 6006, `SlippageExceeded` 6009,
  `CloseTimeNotReached` 6004, `AccountNotInitialized` 3012 — all identical.
* PDA derivation, including the hand-derived market PDA
  (`sha256` over raw UTF-8 question bytes).
* Event encoding and `EventParser` decoding.
* The vault solvency identity and the 1:1 winner payout.
* `init_if_needed` on the position account, and `close = owner` refunding rent.

---

## 6. Files

| Path | What it is |
|---|---|
| `scripts/devnet/setup.sh` | Switch the CLI to devnet, verify keys/balance, report. `--restore` switches back. |
| `scripts/devnet/deploy.sh` | `anchor build --arch v0` → `anchor deploy --provider.cluster devnet`, with the keypair guard. |
| `scripts/devnet/fund.ts` | The three USDC paths, SOL transfers, persisted wallets. Writes `~/.greekbet-devnet/funding.json`. |
| `scripts/devnet/run-lifecycle.sh` | `fund.ts` then mocha over the devnet spec only. |
| `tests/devnet/lifecycle.ts` | The lifecycle. Self-skips unless `ANCHOR_PROVIDER_URL` names devnet. |
| `~/.greekbet-devnet/` | State: wallets, custom mint keypair, keypair backups, `funding.json`, `lifecycle-run.json`. **Not in the repo.** |
