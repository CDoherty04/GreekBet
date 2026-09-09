/**
 * tests/parity.ts - on-chain results vs. the Python oracle, with **zero
 * tolerance** (plan 4.2: "match LMSR module output exactly").
 *
 * This is the strongest test in the suite. It replays sequences from
 * `reference/vectors/trades.json` against a real market on a real validator
 * and requires byte-exact integer equality on every observable the oracle
 * publishes: share counts, collateral, `q_yes` / `q_no`, the marginal price,
 * and the running vault balance.
 *
 * ## Which sequences can be replayed, and why not all 48
 *
 * `trades.json` uses three step operations. Only two of them have a
 * corresponding instruction:
 *
 * | vector `op` | instruction | replayable |
 * |---|---|---|
 * | `buy_with_collateral` | `buy_shares(outcome, usdc_amount, ..)` | yes |
 * | `sell` | `sell_shares(outcome, share_amount, ..)` | yes |
 * | `buy` | *(none)* | **no** |
 *
 * `buy` is **share-denominated**: it names a share count and the oracle
 * returns `buy_cost` of it. The program has no share-denominated buy -
 * `buy_shares` is collateral-denominated on purpose, because
 * `buy_cost(shares_for_cost(c))` overshoots `c` by one base unit about once in
 * 10,000 (crates/lmsr/tests/README.md 11), and charging the caller's own
 * integer sidesteps that entirely. There is therefore no instruction that can
 * reproduce a `buy` step, and no way to steer a market onto a `buy` sequence's
 * intermediate states, since `q` is only reachable through the collateral
 * quote.
 *
 * So the replayable set is exactly: every sequence that starts at `q = (0,0)`
 * and uses only `buy_with_collateral` and `sell`. That is the six
 * `collateral_ladder` sequences (one per `b` decade) plus `random_walk_1` at
 * `b = 10 USDC` - **61 steps across the whole legal `b` range**. The filter is
 * computed from the file, not hardcoded, so a regenerated vector set with more
 * collateral-denominated sequences is picked up automatically.
 *
 * The unreachable steps are not untested elsewhere: `crates/lmsr/tests/`
 * replays all 48 sequences (503 steps) against the same crate this program
 * calls, twice each. What this file adds is that the *program* neither
 * rescales, re-rounds, nor re-prices anything on the way in or out.
 *
 * ## Zero-cost trades: the one expected divergence
 *
 * `buy_shares` and `sell_shares` reject zero-output trades with
 * `ZeroCostTrade`, which the oracle does not (reference/README.md, "Behaviours
 * T04/T07 should expect", item 1). None of the replayable steps is degenerate,
 * so it never fires here; `negative.ts` covers it directly.
 */

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import {
  assertSolvent,
  bLn2Floor,
  big,
  bn,
  Collateral,
  createCollateralMint,
  createMarketFixture,
  derivePosition,
  fundedTrader,
  getProgram,
  outcomeArg,
  positionExists,
  readMarket,
  readPosition,
  requireEvent,
  rpcWithEvents,
  Side,
  tokenBalance,
  VaultLedger,
  waitForOnChainTime,
} from "./utils";

// ---------------------------------------------------------------------------
// Vector loading
// ---------------------------------------------------------------------------

interface VecStep {
  index: number;
  op: "buy" | "sell" | "buy_with_collateral";
  outcome: Side;
  shares: string;
  collateral?: string;
  collateral_in?: string;
  collateral_out?: string;
  q_yes_after: string;
  q_no_after: string;
  cost_after: string;
  price_yes_after: string;
  net_collateral_after: string;
  solvency_margin_exact: string;
}

interface VecSequence {
  id: string;
  name: string;
  b: string;
  q_yes: string;
  q_no: string;
  cost_initial: string;
  step_count: number;
  steps: VecStep[];
}

const VECTOR_PATH = path.resolve(__dirname, "..", "reference", "vectors", "trades.json");

/**
 * Read the vectors as **text**, then parse.
 *
 * Every integer in the file is a JSON *string* precisely because `q` and
 * `cost` run past 2^53 (reference/README.md, "Encoding rules"). They are
 * converted with `BigInt`, never `Number`.
 */
function loadSequences(): VecSequence[] {
  const raw = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
  expect(raw.schema).to.equal("greekbet.lmsr.vectors.v1");
  expect(raw.kind).to.equal("trades");
  return raw.cases as VecSequence[];
}

function isReplayable(seq: VecSequence): boolean {
  return (
    seq.q_yes === "0" &&
    seq.q_no === "0" &&
    seq.steps.every((s) => s.op === "buy_with_collateral" || s.op === "sell")
  );
}

/** `floor(x)` for a non-negative decimal string, including e-notation. */
function floorDecimal(s: string): bigint {
  const v = s.trim();
  if (/[eE]/.test(v)) {
    // The only exponential values in this file are tiny positive magnitudes.
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`cannot floor ${s}`);
    return BigInt(Math.floor(n));
  }
  const neg = v.startsWith("-");
  const body = neg ? v.slice(1) : v;
  const [intPart, frac = ""] = body.split(".");
  const i = BigInt(intPart || "0");
  if (!neg) return i;
  return /[1-9]/.test(frac) ? -i - 1n : -i;
}

// ---------------------------------------------------------------------------

describe("parity: on-chain results match reference/vectors/trades.json exactly", () => {
  const program = getProgram();
  const all = loadSequences();
  const replayable = all.filter(isReplayable);

  let collateral: Collateral;

  before(async function () {
    this.timeout(300_000);
    collateral = await createCollateralMint();
  });

  /**
   * Pin the coverage so it cannot shrink unnoticed.
   *
   * The skip reasons are stated per sequence rather than left implicit: a
   * sequence is skipped either because it contains a share-denominated `buy`
   * (no such instruction exists) or because it starts at a non-zero `q` (an
   * on-chain market always starts at `(0,0)` and `q` is only reachable through
   * the collateral quote), and both of those are properties of the *program's
   * instruction surface*, not of this test.
   */
  it("the replayable subset is exactly the 7 sequences the program can express", () => {
    expect(all.length, "trades.json case count").to.equal(48);

    const skipped: Record<string, string[]> = {
      "share-denominated buy step (no such instruction)": [],
      "starts at non-zero q (unreachable on chain)": [],
    };
    for (const s of all) {
      if (isReplayable(s)) continue;
      if (s.q_yes !== "0" || s.q_no !== "0") {
        skipped["starts at non-zero q (unreachable on chain)"].push(s.id);
      } else {
        skipped["share-denominated buy step (no such instruction)"].push(s.id);
      }
    }

    const ids = replayable.map((s) => s.id).sort();
    expect(ids, "the replayable set drifted").to.deep.equal([
      "trades-00004",
      "trades-00007",
      "trades-00012",
      "trades-00020",
      "trades-00028",
      "trades-00036",
      "trades-00044",
    ]);
    const steps = replayable.reduce((n, s) => n + s.steps.length, 0);
    expect(steps, "replayable step count").to.equal(61);
    // All six b decades, and both trade directions.
    expect(new Set(replayable.map((s) => s.b)).size, "b decades covered").to.equal(6);
    expect(
      replayable.some((s) => s.steps.some((st) => st.op === "sell")),
      "no sell steps in the replayable set"
    ).to.equal(true);

    const opCounts: Record<string, number> = {};
    for (const s of all) for (const st of s.steps) opCounts[st.op] = (opCounts[st.op] ?? 0) + 1;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        `  replaying ${replayable.length}/48 sequences, ${steps} steps, on chain:`,
        ...replayable.map((s) => `    ${s.id}  ${s.name} b=${s.b} (${s.step_count} steps)`),
        `  file-wide step ops: ${Object.entries(opCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
        "  skipped, with reason:",
        ...Object.entries(skipped).map(([why, list]) => `    ${list.length} x ${why}`),
        "",
      ].join("\n")
    );
  });

  it("the on-chain vault seed formula agrees with the oracle at every b", () => {
    const seen = new Set<string>();
    for (const seq of all) {
      if (seen.has(seq.b)) continue;
      seen.add(seq.b);
      const b = BigInt(seq.b);
      expect(bLn2Floor(b).toString(), `cost_initial mismatch at b=${b}`).to.equal(seq.cost_initial);
    }
    expect(seen.size, "b decades covered").to.equal(6);
  });

  for (const seq of replayable) {
    const b = BigInt(seq.b);
    const costInitial = BigInt(seq.cost_initial);

    it(`replays ${seq.name} at b=${seq.b} (${seq.step_count} steps) with zero tolerance`, async function () {
      this.timeout(600_000);

      const spend = seq.steps
        .filter((s) => s.op === "buy_with_collateral")
        .reduce((acc, s) => acc + BigInt(s.collateral!), 0n);

      const trader = await fundedTrader(collateral, spend * 2n + 1_000_000n);
      const fx = await createMarketFixture(collateral, {
        b,
        question: `parity ${seq.name} b=${seq.b} ${seq.id}`,
        closeTimeSecondsFromNow: 3600,
        creatorFunding: costInitial * 4n,
      });
      const [position] = derivePosition(program.programId, fx.market, trader.keypair.publicKey);
      const ledger = new VaultLedger(costInitial);

      // The seed the program deposited must equal the oracle's C(0,0).
      const seeded = await tokenBalance(fx.vault);
      expect(seeded.toString(), `${seq.id}: vault seed != oracle cost_initial`).to.equal(
        costInitial.toString()
      );

      let posYes = 0n;
      let posNo = 0n;

      for (const step of seq.steps) {
        const where = `${seq.id} step ${step.index} (${step.op} ${step.outcome})`;
        const walletBefore = await tokenBalance(trader.tokenAccount);

        let sharesMoved: bigint;
        let collateralMoved: bigint;
        let evQYes: bigint;
        let evQNo: bigint;
        let evPrice: bigint;

        if (step.op === "buy_with_collateral") {
          const spendHere = BigInt(step.collateral!);
          const tx = await rpcWithEvents(
            program,
            program.methods
              .buyShares(outcomeArg(step.outcome), bn(spendHere), bn(0))
              .accountsPartial({
                buyer: trader.keypair.publicKey,
                market: fx.market,
                position,
                vault: fx.vault,
                buyerTokenAccount: trader.tokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              }),
            [trader.keypair]
          );
          const ev = requireEvent(tx, "sharesBought");
          sharesMoved = big(ev.sharesOut);
          collateralMoved = big(ev.collateralIn);
          evQYes = big(ev.qYesAfter);
          evQNo = big(ev.qNoAfter);
          evPrice = big(ev.priceYesAfter);

          // ---- the parity assertions ----
          expect(sharesMoved.toString(), `${where}: shares_out`).to.equal(step.shares);
          expect(collateralMoved.toString(), `${where}: collateral charged`).to.equal(
            step.collateral!
          );

          ledger.in(spendHere);
          const walletAfter = await tokenBalance(trader.tokenAccount);
          expect((walletBefore - walletAfter).toString(), `${where}: buyer debit`).to.equal(
            spendHere.toString()
          );
          if (step.outcome === "yes") posYes += sharesMoved;
          else posNo += sharesMoved;
        } else {
          const sharesHere = BigInt(step.shares);
          const tx = await rpcWithEvents(
            program,
            program.methods
              .sellShares(outcomeArg(step.outcome), bn(sharesHere), bn(0))
              .accountsPartial({
                seller: trader.keypair.publicKey,
                market: fx.market,
                position,
                vault: fx.vault,
                sellerTokenAccount: trader.tokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
              }),
            [trader.keypair]
          );
          const ev = requireEvent(tx, "sharesSold");
          sharesMoved = big(ev.sharesIn);
          collateralMoved = big(ev.collateralOut);
          evQYes = big(ev.qYesAfter);
          evQNo = big(ev.qNoAfter);
          evPrice = big(ev.priceYesAfter);

          expect(sharesMoved.toString(), `${where}: shares_in`).to.equal(step.shares);
          expect(collateralMoved.toString(), `${where}: sell_return`).to.equal(
            step.collateral_out!
          );

          ledger.out(collateralMoved);
          const walletAfter = await tokenBalance(trader.tokenAccount);
          expect((walletAfter - walletBefore).toString(), `${where}: seller credit`).to.equal(
            collateralMoved.toString()
          );
          if (step.outcome === "yes") posYes -= sharesMoved;
          else posNo -= sharesMoved;
        }

        // State after the step: event, account, and oracle must all agree.
        expect(evQYes.toString(), `${where}: event q_yes_after`).to.equal(step.q_yes_after);
        expect(evQNo.toString(), `${where}: event q_no_after`).to.equal(step.q_no_after);
        expect(evPrice.toString(), `${where}: price_yes_after`).to.equal(step.price_yes_after);

        const { vault, market } = await assertSolvent(program, fx, ledger, where);
        expect(market.qYes.toString(), `${where}: account q_yes`).to.equal(step.q_yes_after);
        expect(market.qNo.toString(), `${where}: account q_no`).to.equal(step.q_no_after);

        // The oracle's own running ledger, base unit for base unit.
        expect(
          (vault - costInitial).toString(),
          `${where}: net collateral vs oracle`
        ).to.equal(step.net_collateral_after);

        // And the surplus over the *exact* cost function.
        //
        // `vault - cost_after` is an integer; the oracle's
        // `solvency_margin_exact` is the same quantity measured in reals
        // against unrounded costs. The two differ by
        // `frac(C(q)) - frac(C(0,0))`, which lies strictly in `(-1, 1)`, so an
        // integer surplus can only be `floor(margin)` or `floor(margin) + 1` -
        // and never less than zero, which is the solvency half of the rounding
        // policy ("money never rounds in the user's favour",
        // reference/README.md). Both bounds are exact; neither is a fudge
        // factor for implementation error.
        const surplus = vault - BigInt(step.cost_after);
        const floorMargin = floorDecimal(step.solvency_margin_exact);
        expect(
          surplus === floorMargin || surplus === floorMargin + 1n,
          `${where}: rounding surplus ${surplus} is not within one base unit of the ` +
            `oracle margin ${step.solvency_margin_exact}`
        ).to.equal(true);
        expect(surplus >= 0n, `${where}: vault below C(q)`).to.equal(true);
        expect(
          surplus <= BigInt(step.index) + 1n,
          `${where}: rounding surplus ${surplus} exceeds one base unit per step`
        ).to.equal(true);

        const pos = await readPosition(program, position);
        expect(pos.yesShares.toString(), `${where}: position yes`).to.equal(posYes.toString());
        expect(pos.noShares.toString(), `${where}: position no`).to.equal(posNo.toString());
      }
    });
  }

  /**
   * The rounding-dust question, answered where it is actually answerable.
   *
   * Replay a full ladder, then close, resolve and redeem, and decompose the
   * final vault balance against the oracle:
   *
   *   residual        = vault - q_win          (what is left after payouts)
   *   true subsidy    = C(q) - q_win           (oracle, exact)
   *   rounding dust   = vault - C(q)           (integer drift, must be small)
   *
   * The dust is the only part that rounding controls, and the policy caps it
   * at "money never rounds in the user's favour" - i.e. it must be >= 0, and
   * over `n` steps it cannot exceed `n` base units.
   */
  it("quantifies the post-redemption residual against the oracle's cost function", async function () {
    this.timeout(600_000);

    const seq = replayable.find((s) => s.name === "collateral_ladder" && s.b === "10000000")!;
    const costInitial = BigInt(seq.cost_initial);
    const last = seq.steps[seq.steps.length - 1];
    const spend = seq.steps.reduce((acc, s) => acc + BigInt(s.collateral!), 0n);

    const trader = await fundedTrader(collateral, spend * 2n);
    const fx = await createMarketFixture(collateral, {
      b: BigInt(seq.b),
      question: `parity redemption ${seq.id}`,
      closeTimeSecondsFromNow: 25,
      creatorFunding: costInitial * 4n,
    });
    const [position] = derivePosition(program.programId, fx.market, trader.keypair.publicKey);
    const ledger = new VaultLedger(costInitial);

    for (const step of seq.steps) {
      const tx = await rpcWithEvents(
        program,
        program.methods
          .buyShares(outcomeArg(step.outcome), bn(BigInt(step.collateral!)), bn(0))
          .accountsPartial({
            buyer: trader.keypair.publicKey,
            market: fx.market,
            position,
            vault: fx.vault,
            buyerTokenAccount: trader.tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
        [trader.keypair]
      );
      expect(big(requireEvent(tx, "sharesBought").sharesOut).toString()).to.equal(step.shares);
      ledger.in(BigInt(step.collateral!));
    }

    const vaultBefore = await tokenBalance(fx.vault);
    const costAfter = BigInt(last.cost_after);
    const dust = vaultBefore - costAfter;
    const floorMargin = floorDecimal(last.solvency_margin_exact);
    expect(
      dust === floorMargin || dust === floorMargin + 1n,
      `accumulated rounding surplus ${dust} is not within one base unit of the ` +
        `oracle margin ${last.solvency_margin_exact}`
    ).to.equal(true);
    expect(dust >= 0n, "vault fell below the exact cost function").to.equal(true);
    expect(
      dust <= BigInt(seq.step_count),
      `rounding surplus ${dust} exceeds 1 base unit per step`
    ).to.equal(true);

    await waitForOnChainTime(fx.closeTime);
    await rpcWithEvents(program, program.methods.closeMarket().accountsPartial({ market: fx.market }));
    await rpcWithEvents(
      program,
      program.methods
        .resolveMarket(outcomeArg("yes"))
        .accountsPartial({ market: fx.market, resolver: fx.resolver.publicKey }),
      [fx.resolver]
    );

    const qYes = BigInt(last.q_yes_after);
    const qNo = BigInt(last.q_no_after);
    const tx = await rpcWithEvents(
      program,
      program.methods.redeem().accountsPartial({
        owner: trader.keypair.publicKey,
        market: fx.market,
        position,
        vault: fx.vault,
        ownerTokenAccount: trader.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [trader.keypair]
    );
    const payout = big(requireEvent(tx, "redeemed").payout);
    expect(payout.toString(), "winner not paid q_yes 1:1").to.equal(qYes.toString());
    expect(await positionExists(position)).to.equal(false);

    const residual = await tokenBalance(fx.vault);
    const trueSubsidy = costAfter - qYes;
    expect(residual.toString()).to.equal((vaultBefore - payout).toString());
    expect(residual >= 0n, "vault insolvent after redemption").to.equal(true);
    expect((residual - trueSubsidy).toString(), "residual decomposition").to.equal(
      dust.toString()
    );

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  ---- post-redemption residual, decomposed against the oracle ----",
        `  sequence                = ${seq.id} ${seq.name} b=${seq.b} (${seq.step_count} buys)`,
        `  vault before redemption = ${vaultBefore}`,
        `  oracle C(q)  cost_after = ${costAfter}`,
        `  q_yes / q_no            = ${qYes} / ${qNo}`,
        `  payout (q_yes, 1:1)     = ${payout}`,
        `  RESIDUAL                = ${residual}`,
        `    unspent LMSR subsidy  = ${trueSubsidy}   (= C(q) - q_win, exact)`,
        `    ROUNDING DUST         = ${dust}   (= vault - C(q), over ${seq.step_count} steps)`,
        `    oracle margin_exact   = ${last.solvency_margin_exact}`,
        "  policy: dust must be >= 0 (never in the user's favour) and <= 1 base",
        "  unit per step; both asserted above.",
        "",
      ].join("\n")
    );
  });
});
