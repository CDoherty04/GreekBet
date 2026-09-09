/**
 * tests/lifecycle.ts - the happy path, in order (plan 4.2 / T09 task 3).
 *
 * create -> buy (three users) -> sell -> close -> resolve -> redeem.
 *
 * The tests in this file are **ordered and share state**; mocha runs them in
 * declaration order and each one builds on the market the previous one left
 * behind. That is deliberate: the exit criterion is about a lifecycle, not
 * about six independent instructions.
 *
 * Every step ends with `assertSolvent`, which makes two zero-tolerance claims:
 * the vault holds exactly `seed + (sum in) - (sum out)`, and it holds at least
 * `max(q_yes, q_no)` - the largest payout resolution could possibly produce.
 *
 * ## On "the vault is fully drained after redemption"
 *
 * It is not, and it should not be. After every winner redeems, the vault holds
 * `C(q) - q_win`, which is the market maker's *unspent subsidy*: it goes to
 * zero only in the limit where the market resolved at absolute certainty. What
 * this file asserts instead is the exact identity
 * `residual = seed + (sum in) - (sum out) - (sum payouts)`, that the residual
 * is non-negative (solvency), and - since the winning side is the heavier one
 * here - that it never exceeds the `b*ln2` seed. The residual is printed.
 * `parity.ts` quantifies the *rounding* component of it exactly, against the
 * oracle's `cost_after`, which is the only place that number is knowable
 * without re-implementing the LMSR in TypeScript.
 */

import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";

import {
  assertIdlErrorCodesMatch,
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
  MarketFixture,
  maxBig,
  outcomeArg,
  positionExists,
  readMarket,
  readPosition,
  requireEvent,
  rpcWithEvents,
  sha256,
  tokenBalance,
  UNIT,
  VaultLedger,
  waitForOnChainTime,
} from "./utils";

describe("lifecycle: create -> buy -> sell -> close -> resolve -> redeem", () => {
  const program = getProgram();
  const B = 100_000_000n; // 100 USDC of liquidity
  const FUNDING = 1_000_000_000n; // 1,000 USDC each

  let collateral: Collateral;
  let fx: MarketFixture;
  let ledger: VaultLedger;

  // Traders. A and C buy YES (the eventual winner), B buys NO.
  let a: { keypair: Keypair; tokenAccount: PublicKey };
  let b: { keypair: Keypair; tokenAccount: PublicKey };
  let c: { keypair: Keypair; tokenAccount: PublicKey };
  let posA: PublicKey;
  let posB: PublicKey;
  let posC: PublicKey;

  // Observations carried between steps.
  const priceAfter: bigint[] = [];
  /**
   * Compute units per instruction, scraped from the program's own
   * "consumed N of M" log line.
   *
   * Not asserted against a threshold - `crates/lmsr/tests/compute_budget.rs`
   * owns that, and it caps the *LMSR maths* rather than the whole
   * instruction. Recorded because the number that matters on devnet (T10) is
   * the whole instruction including Anchor's account deserialisation and the
   * token CPI, and this is the only place it is observable.
   */
  const cu: Record<string, number | null> = {};
  let sharesA = 0n;
  let sharesB = 0n;
  let sharesC = 0n;
  let payouts = 0n;

  before(async function () {
    this.timeout(300_000);
    assertIdlErrorCodesMatch(program);
    collateral = await createCollateralMint();
    a = await fundedTrader(collateral, FUNDING);
    b = await fundedTrader(collateral, FUNDING);
    c = await fundedTrader(collateral, FUNDING);
  });

  it("creates a market and seeds the vault with exactly b*ln2", async function () {
    this.timeout(120_000);

    fx = await createMarketFixture(collateral, {
      b: B,
      // Long enough for four trades plus the wait, short enough not to stall
      // the suite. There is no clock warp on solana-test-validator.
      closeTimeSecondsFromNow: 20,
    });
    ledger = new VaultLedger(fx.seed);

    posA = derivePosition(program.programId, fx.market, a.keypair.publicKey)[0];
    posB = derivePosition(program.programId, fx.market, b.keypair.publicKey)[0];
    posC = derivePosition(program.programId, fx.market, c.keypair.publicKey)[0];

    const m = await readMarket(program, fx.market);
    expect(m.creator.toBase58()).to.equal(fx.creator.publicKey.toBase58());
    expect(m.resolver.toBase58()).to.equal(fx.resolver.publicKey.toBase58());
    expect(m.collateralMint.toBase58()).to.equal(collateral.mint.toBase58());
    expect(m.vault.toBase58()).to.equal(fx.vault.toBase58());
    expect(m.question).to.equal(fx.question);
    expect(m.questionHash.toString("hex")).to.equal(sha256(fx.question).toString("hex"));
    expect(m.b.toString()).to.equal(B.toString());
    expect(m.qYes.toString()).to.equal("0");
    expect(m.qNo.toString()).to.equal("0");
    expect(m.status).to.equal("open");
    expect(m.winningOutcome).to.equal(null);
    expect(m.closeTime.toString()).to.equal(fx.closeTime.toString());

    // The seed: `lmsr::cost(0, 0, b)` == floor(b * ln 2), computed on chain.
    const vault = await tokenBalance(fx.vault);
    expect(vault.toString(), "vault seed is not b*ln2").to.equal(bLn2Floor(B).toString());
    expect(vault.toString()).to.equal("69314718");

    // And the event agrees with the account.
    const ev = requireEvent(fx.createTx, "marketCreated");
    cu["create_market"] = fx.createTx.computeUnits;
    expect(big(ev.seedAmount).toString()).to.equal(vault.toString());
    expect(big(ev.b).toString()).to.equal(B.toString());

    await assertSolvent(program, fx, ledger, "after create");
  });

  it("buy YES as A: shares credited, q_yes moves, vault up by exactly the USDC paid", async function () {
    this.timeout(120_000);
    const spend = 10_000_000n; // 10 USDC

    const walletBefore = await tokenBalance(a.tokenAccount);
    const vaultBefore = await tokenBalance(fx.vault);
    const before = await readMarket(program, fx.market);

    const tx = await rpcWithEvents(
      program,
      program.methods.buyShares(outcomeArg("yes"), bn(spend), bn(0)).accountsPartial({
        buyer: a.keypair.publicKey,
        market: fx.market,
        position: posA,
        vault: fx.vault,
        buyerTokenAccount: a.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [a.keypair]
    );
    ledger.in(spend);

    const ev = requireEvent(tx, "sharesBought");
    cu["buy_shares (first buy: position init_if_needed)"] = tx.computeUnits;
    sharesA = big(ev.sharesOut);
    expect(sharesA > 0n, "a 10 USDC buy credited no shares").to.equal(true);
    expect(big(ev.collateralIn).toString(), "charged something other than the argument").to.equal(
      spend.toString()
    );

    const after = await readMarket(program, fx.market);
    expect((after.qYes - before.qYes).toString(), "q_yes delta != shares credited").to.equal(
      sharesA.toString()
    );
    expect(after.qNo.toString()).to.equal(before.qNo.toString());

    const pos = await readPosition(program, posA);
    expect(pos.yesShares.toString()).to.equal(sharesA.toString());
    expect(pos.noShares.toString()).to.equal("0");
    expect(pos.owner.toBase58()).to.equal(a.keypair.publicKey.toBase58());
    expect(pos.market.toBase58()).to.equal(fx.market.toBase58());

    const vaultAfter = await tokenBalance(fx.vault);
    const walletAfter = await tokenBalance(a.tokenAccount);
    expect((vaultAfter - vaultBefore).toString(), "vault did not rise by the spend").to.equal(
      spend.toString()
    );
    expect((walletBefore - walletAfter).toString(), "buyer was not charged the spend").to.equal(
      spend.toString()
    );

    priceAfter.push(big(ev.priceYesAfter));
    expect(priceAfter[0] > UNIT / 2n, "buying YES did not push price above 0.5").to.equal(true);

    await assertSolvent(program, fx, ledger, "after A buys YES");
  });

  it("buy NO as B: price_yes moves the other way", async function () {
    this.timeout(120_000);
    const spend = 4_000_000n;

    const vaultBefore = await tokenBalance(fx.vault);
    const before = await readMarket(program, fx.market);

    const tx = await rpcWithEvents(
      program,
      program.methods.buyShares(outcomeArg("no"), bn(spend), bn(0)).accountsPartial({
        buyer: b.keypair.publicKey,
        market: fx.market,
        position: posB,
        vault: fx.vault,
        buyerTokenAccount: b.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [b.keypair]
    );
    ledger.in(spend);

    const ev = requireEvent(tx, "sharesBought");
    sharesB = big(ev.sharesOut);
    const after = await readMarket(program, fx.market);
    expect((after.qNo - before.qNo).toString()).to.equal(sharesB.toString());
    expect(after.qYes.toString()).to.equal(before.qYes.toString());

    const vaultAfter = await tokenBalance(fx.vault);
    expect((vaultAfter - vaultBefore).toString()).to.equal(spend.toString());

    priceAfter.push(big(ev.priceYesAfter));
    expect(
      priceAfter[1] < priceAfter[0],
      `buying NO did not lower price_yes (${priceAfter[0]} -> ${priceAfter[1]})`
    ).to.equal(true);

    await assertSolvent(program, fx, ledger, "after B buys NO");
  });

  it("buy more YES as C: price_yes rises again and ends above where it started", async function () {
    this.timeout(120_000);
    const spend = 20_000_000n;

    const vaultBefore = await tokenBalance(fx.vault);
    const before = await readMarket(program, fx.market);

    const tx = await rpcWithEvents(
      program,
      program.methods.buyShares(outcomeArg("yes"), bn(spend), bn(0)).accountsPartial({
        buyer: c.keypair.publicKey,
        market: fx.market,
        position: posC,
        vault: fx.vault,
        buyerTokenAccount: c.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [c.keypair]
    );
    ledger.in(spend);

    const ev = requireEvent(tx, "sharesBought");
    sharesC = big(ev.sharesOut);
    const after = await readMarket(program, fx.market);
    expect((after.qYes - before.qYes).toString()).to.equal(sharesC.toString());

    const vaultAfter = await tokenBalance(fx.vault);
    expect((vaultAfter - vaultBefore).toString()).to.equal(spend.toString());

    priceAfter.push(big(ev.priceYesAfter));

    // Monotonicity, stated precisely. A YES buy raises price_yes and a NO buy
    // lowers it, so "monotonically rising across the three trades" is only true
    // of the YES-buy subsequence - the NO buy in the middle necessarily dips.
    // Both halves of that are asserted, plus the net effect.
    expect(
      priceAfter[2] > priceAfter[1],
      `second YES buy did not raise price_yes (${priceAfter[1]} -> ${priceAfter[2]})`
    ).to.equal(true);
    expect(
      priceAfter[2] > priceAfter[0],
      `net YES buying pressure did not raise price_yes (${priceAfter[0]} -> ${priceAfter[2]})`
    ).to.equal(true);
    expect(priceAfter.every((p) => p > 0n && p < UNIT)).to.equal(true);

    await assertSolvent(program, fx, ledger, "after C buys YES");
  });

  it("sell part of A's position: USDC returned, position and q debited exactly", async function () {
    this.timeout(120_000);
    const toSell = sharesA / 2n;
    expect(toSell > 0n).to.equal(true);

    const walletBefore = await tokenBalance(a.tokenAccount);
    const vaultBefore = await tokenBalance(fx.vault);
    const before = await readMarket(program, fx.market);
    const posBefore = await readPosition(program, posA);

    const tx = await rpcWithEvents(
      program,
      program.methods.sellShares(outcomeArg("yes"), bn(toSell), bn(0)).accountsPartial({
        seller: a.keypair.publicKey,
        market: fx.market,
        position: posA,
        vault: fx.vault,
        sellerTokenAccount: a.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [a.keypair]
    );

    const ev = requireEvent(tx, "sharesSold");
    cu["sell_shares"] = tx.computeUnits;
    const proceeds = big(ev.collateralOut);
    expect(proceeds > 0n).to.equal(true);
    ledger.out(proceeds);
    sharesA -= toSell;

    const walletAfter = await tokenBalance(a.tokenAccount);
    const vaultAfter = await tokenBalance(fx.vault);
    expect((walletAfter - walletBefore).toString(), "seller was not paid the proceeds").to.equal(
      proceeds.toString()
    );
    expect((vaultBefore - vaultAfter).toString(), "vault did not fall by the proceeds").to.equal(
      proceeds.toString()
    );

    const posAfter = await readPosition(program, posA);
    expect((posBefore.yesShares - posAfter.yesShares).toString()).to.equal(toSell.toString());
    expect(posAfter.yesShares.toString()).to.equal(sharesA.toString());

    const after = await readMarket(program, fx.market);
    expect((before.qYes - after.qYes).toString()).to.equal(toSell.toString());

    // A round trip must never pay out more than it took in - the vault-drain
    // vector. A bought 10 USDC of YES and has just unwound half of it.
    expect(proceeds < 10_000_000n).to.equal(true);

    await assertSolvent(program, fx, ledger, "after A sells half");
  });

  it("waits for close_time and closes the market", async function () {
    this.timeout(300_000);
    await waitForOnChainTime(fx.closeTime);

    const tx = await rpcWithEvents(
      program,
      program.methods.closeMarket().accountsPartial({ market: fx.market })
    );
    const ev = requireEvent(tx, "marketClosed");
    cu["close_market"] = tx.computeUnits;
    expect(big(ev.closeTime).toString()).to.equal(fx.closeTime.toString());

    const m = await readMarket(program, fx.market);
    expect(m.status).to.equal("closed");
    expect(m.winningOutcome).to.equal(null);

    await assertSolvent(program, fx, ledger, "after close");
  });

  it("resolves YES as the resolver", async function () {
    this.timeout(120_000);
    const tx = await rpcWithEvents(
      program,
      program.methods
        .resolveMarket(outcomeArg("yes"))
        .accountsPartial({ market: fx.market, resolver: fx.resolver.publicKey }),
      [fx.resolver]
    );
    const ev = requireEvent(tx, "marketResolved");
    cu["resolve_market"] = tx.computeUnits;
    expect(Object.keys(ev.winningOutcome)[0]).to.equal("yes");

    const m = await readMarket(program, fx.market);
    expect(m.status).to.equal("resolved");
    expect(m.winningOutcome).to.equal("yes");

    await assertSolvent(program, fx, ledger, "after resolve");
  });

  it("redeems winners 1:1 and the loser for zero, closing every position", async function () {
    this.timeout(300_000);
    const m = await readMarket(program, fx.market);
    const qYesAtResolution = m.qYes;

    // --- A (winner, partially unwound) ---
    {
      const walletBefore = await tokenBalance(a.tokenAccount);
      const tx = await rpcWithEvents(
        program,
        program.methods.redeem().accountsPartial({
          owner: a.keypair.publicKey,
          market: fx.market,
          position: posA,
          vault: fx.vault,
          ownerTokenAccount: a.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [a.keypair]
      );
      const ev = requireEvent(tx, "redeemed");
      cu["redeem (winner, pays out)"] = tx.computeUnits;
      const payout = big(ev.payout);
      expect(payout.toString(), "winner not paid 1:1").to.equal(sharesA.toString());
      const walletAfter = await tokenBalance(a.tokenAccount);
      expect((walletAfter - walletBefore).toString()).to.equal(payout.toString());
      expect(await positionExists(posA), "position was not closed").to.equal(false);
      ledger.out(payout);
      payouts += payout;
      await assertSolvent(program, fx, ledger, "after A redeems");
    }

    // --- C (winner) ---
    {
      const walletBefore = await tokenBalance(c.tokenAccount);
      const tx = await rpcWithEvents(
        program,
        program.methods.redeem().accountsPartial({
          owner: c.keypair.publicKey,
          market: fx.market,
          position: posC,
          vault: fx.vault,
          ownerTokenAccount: c.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [c.keypair]
      );
      const payout = big(requireEvent(tx, "redeemed").payout);
      expect(payout.toString(), "winner not paid 1:1").to.equal(sharesC.toString());
      const walletAfter = await tokenBalance(c.tokenAccount);
      expect((walletAfter - walletBefore).toString()).to.equal(payout.toString());
      expect(await positionExists(posC)).to.equal(false);
      ledger.out(payout);
      payouts += payout;
      await assertSolvent(program, fx, ledger, "after C redeems");
    }

    // --- B (loser: paid zero, position still cleared and rent returned) ---
    {
      const walletBefore = await tokenBalance(b.tokenAccount);
      const lamportsBefore = await program.provider.connection.getBalance(
        b.keypair.publicKey,
        "confirmed"
      );
      const tx = await rpcWithEvents(
        program,
        program.methods.redeem().accountsPartial({
          owner: b.keypair.publicKey,
          market: fx.market,
          position: posB,
          vault: fx.vault,
          ownerTokenAccount: b.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [b.keypair]
      );
      const ev = requireEvent(tx, "redeemed");
      cu["redeem (loser, no transfer)"] = tx.computeUnits;
      expect(big(ev.payout).toString(), "loser was paid something").to.equal("0");
      expect(big(ev.losingShares).toString()).to.equal(sharesB.toString());
      expect(big(ev.winningShares).toString()).to.equal("0");
      const walletAfter = await tokenBalance(b.tokenAccount);
      expect(walletAfter.toString(), "loser's collateral balance changed").to.equal(
        walletBefore.toString()
      );
      expect(await positionExists(posB), "loser's position was not closed").to.equal(false);
      const lamportsAfter = await program.provider.connection.getBalance(
        b.keypair.publicKey,
        "confirmed"
      );
      expect(lamportsAfter > lamportsBefore, "loser did not get their rent back").to.equal(true);
      await assertSolvent(program, fx, ledger, "after B redeems");
    }

    // --- residual ---
    const residual = await tokenBalance(fx.vault);
    const identity = fx.seed + ledger.inflow - ledger.outflow;
    expect(residual.toString(), "residual breaks the collateral identity").to.equal(
      identity.toString()
    );
    expect(payouts.toString(), "total payout != q_yes at resolution").to.equal(
      qYesAtResolution.toString()
    );
    expect(residual >= 0n, "vault went negative").to.equal(true);
    // YES won and YES was the heavier side, so the unspent subsidy is bounded
    // above by the seed: residual = C(q) - q_yes = b*ln(1 + e^-skew) <= b*ln2.
    expect(residual <= fx.seed, `residual ${residual} exceeds the b*ln2 seed ${fx.seed}`).to.equal(
      true
    );

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  ---- lifecycle vault accounting (base units, 1e-6 USDC) ----",
        `  b                       = ${fx.b}`,
        `  seed (b*ln2)            = ${fx.seed}`,
        `  collateral in           = ${ledger.inflow}`,
        `  collateral out          = ${ledger.outflow}`,
        `    of which payouts      = ${payouts}`,
        `  q_yes at resolution     = ${qYesAtResolution}`,
        `  q_no  at resolution     = ${m.qNo}`,
        `  RESIDUAL in vault       = ${residual}`,
        `  residual / seed         = ${(Number(residual) / Number(fx.seed)).toFixed(6)}`,
        "  (residual is the market maker's unspent LMSR subsidy C(q) - q_win,",
        "   not rounding dust; parity.ts isolates the rounding component.)",
        "",
        "  ---- compute units per instruction (whole instruction, not just the maths) ----",
        ...Object.entries(cu).map(
          ([k, v]) =>
            `  ${k.padEnd(46)} = ${v === null ? "n/a" : v} ` +
            `${v === null ? "" : `(${((v / 200_000) * 100).toFixed(1)}% of the 200,000 default)`}`
        ),
        "",
      ].join("\n")
    );

    // Nothing here raises the compute budget, so a passing run is itself proof
    // that every instruction fits the 200,000 CU default. Asserted anyway, so
    // a regression shows up as a number rather than as a mystery failure.
    for (const [name, used] of Object.entries(cu)) {
      if (used === null) continue;
      expect(used < 200_000, `${name} used ${used} CU, at or past the default budget`).to.equal(
        true
      );
    }
  });

  it("leaves nothing owed: every position is gone and the vault never went negative", async () => {
    const m = await readMarket(program, fx.market);
    expect(await positionExists(posA)).to.equal(false);
    expect(await positionExists(posB)).to.equal(false);
    expect(await positionExists(posC)).to.equal(false);
    const vault = await tokenBalance(fx.vault);
    expect(vault >= 0n).to.equal(true);
    expect(maxBig(m.qYes, m.qNo) > 0n).to.equal(true);
  });
});
