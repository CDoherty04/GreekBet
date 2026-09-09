/**
 * tests/concurrency.ts - several users trading both outcomes, interleaved.
 *
 * The on-chain counterpart of T04's bounded-loss property. The claim under
 * test is not "the arithmetic is right" - `parity.ts` settles that - but that
 * **no interleaving of independent users can put the vault behind its
 * obligations**, and that when the market resolves, every winner can actually
 * be paid.
 *
 * Three invariants are checked after **every single instruction**:
 *
 * 1. `vault == seed + (sum in) - (sum out)` - exact bookkeeping. Any drift
 *    means collateral moved outside an instruction this suite accounted for.
 * 2. `vault >= max(q_yes, q_no)` - obligation cover. Resolution has not
 *    happened yet, so the market is on the hook for whichever side wins;
 *    covering the larger of the two covers both.
 * 3. `sum of positions == q` on each side - the accounting that makes (2)
 *    meaningful. If positions and `q` could drift apart, "the vault covers
 *    `q`" would say nothing about what holders can actually claim.
 *
 * Both resolutions are exercised, on two separate markets, because the
 * obligation that binds is the *winning* side's and the two are different
 * numbers. The YES-winning market resolves with YES heavier; the NO-winning
 * market resolves with NO heavier.
 *
 * There is no concurrency at the *transaction* level here: Solana serialises
 * writes to `Market` anyway, so two trades in the same slot are two ordered
 * state transitions, and sending them in parallel would test the RPC client's
 * retry logic rather than the program. What is interleaved is the *users*.
 */

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  assertSolvent,
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
  Side,
  tokenBalance,
  VaultLedger,
  waitForOnChainTime,
} from "./utils";

interface Trader {
  name: string;
  keypair: Keypair;
  tokenAccount: PublicKey;
  position: PublicKey;
  yes: bigint;
  no: bigint;
}

/** One scripted step. A `sell` names a fraction (in 1/100ths) of the holding. */
interface Step {
  who: number;
  op: "buy" | "sell";
  side: Side;
  amount?: bigint; // buy: collateral base units
  pct?: number; // sell: percent of that side's holding
}

/**
 * A fixed, interleaved script. Deterministic on purpose: a random walk that
 * fails is not reproducible, and the interesting structure here (users
 * crossing each other, a user unwinding while another is still accumulating,
 * a late reversal of the majority side) is easier to *design* than to sample.
 */
const SCRIPT: Step[] = [
  { who: 0, op: "buy", side: "yes", amount: 12_000_000n },
  { who: 1, op: "buy", side: "no", amount: 9_000_000n },
  { who: 2, op: "buy", side: "yes", amount: 5_000_000n },
  { who: 3, op: "buy", side: "no", amount: 15_000_000n },
  { who: 0, op: "buy", side: "yes", amount: 7_000_000n },
  { who: 4, op: "buy", side: "no", amount: 3_000_000n },
  { who: 1, op: "sell", side: "no", pct: 40 },
  { who: 2, op: "buy", side: "no", amount: 4_000_000n }, // a user on both sides
  { who: 3, op: "sell", side: "no", pct: 25 },
  { who: 0, op: "sell", side: "yes", pct: 30 },
  { who: 4, op: "buy", side: "yes", amount: 11_000_000n },
  { who: 1, op: "buy", side: "yes", amount: 6_000_000n },
  { who: 2, op: "sell", side: "yes", pct: 100 }, // full unwind, account stays
  { who: 3, op: "buy", side: "yes", amount: 20_000_000n },
  { who: 4, op: "sell", side: "no", pct: 100 },
  { who: 0, op: "buy", side: "no", amount: 8_000_000n },
  { who: 1, op: "sell", side: "yes", pct: 50 },
  { who: 3, op: "buy", side: "no", amount: 13_000_000n },
  // Leaves u2 holding 0/0 with a live position account, so the redemption
  // sweep below has to cope with a claimant who is owed nothing on either
  // side. `sell_shares` does not close the account; only `redeem` does.
  { who: 2, op: "sell", side: "no", pct: 100 },
];

describe("concurrency: interleaved multi-user trading never puts the vault behind", () => {
  const program = getProgram();
  const B = 200_000_000n; // 200 USDC
  const FUNDING = 2_000_000_000n;

  let collateral: Collateral;

  before(async function () {
    this.timeout(300_000);
    collateral = await createCollateralMint();
  });

  async function runMarket(winning: Side, label: string): Promise<void> {
    // Wallets first, market second. `close_time` is real wall-clock time on a
    // local validator (there is no clock warp), so the window has to start
    // after the slow setup, not before it.
    const wallets: { keypair: Keypair; tokenAccount: PublicKey }[] = [];
    for (let i = 0; i < 5; i += 1) wallets.push(await fundedTrader(collateral, FUNDING));

    const fx: MarketFixture = await createMarketFixture(collateral, {
      b: B,
      question: `concurrency ${label}`,
      // Comfortably longer than the scripted trading takes on this validator.
      closeTimeSecondsFromNow: 75,
    });
    const ledger = new VaultLedger(fx.seed);

    const traders: Trader[] = wallets.map((t, i) => ({
      name: `u${i}`,
      keypair: t.keypair,
      tokenAccount: t.tokenAccount,
      position: derivePosition(program.programId, fx.market, t.keypair.publicKey)[0],
      yes: 0n,
      no: 0n,
    }));

    /** Invariant 3: the positions of a market sum to its `q`. */
    async function assertPositionsSumToQ(where: string): Promise<void> {
      let yes = 0n;
      let no = 0n;
      for (const t of traders) {
        if (!(await positionExists(t.position))) continue;
        const p = await readPosition(program, t.position);
        expect(p.yesShares.toString(), `${where}: ${t.name} yes drift`).to.equal(t.yes.toString());
        expect(p.noShares.toString(), `${where}: ${t.name} no drift`).to.equal(t.no.toString());
        yes += p.yesShares;
        no += p.noShares;
      }
      const m = await readMarket(program, fx.market);
      expect(yes.toString(), `${where}: sum(position.yes) != q_yes`).to.equal(m.qYes.toString());
      expect(no.toString(), `${where}: sum(position.no) != q_no`).to.equal(m.qNo.toString());
    }

    let minCover: bigint | null = null;

    for (let i = 0; i < SCRIPT.length; i += 1) {
      const step = SCRIPT[i];
      const t = traders[step.who];
      const where = `${label} step ${i} (${t.name} ${step.op} ${step.side})`;

      if (step.op === "buy") {
        const tx = await rpcWithEvents(
          program,
          program.methods
            .buyShares(outcomeArg(step.side), bn(step.amount!), bn(0))
            .accountsPartial({
              buyer: t.keypair.publicKey,
              market: fx.market,
              position: t.position,
              vault: fx.vault,
              buyerTokenAccount: t.tokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            }),
          [t.keypair]
        );
        const ev = requireEvent(tx, "sharesBought");
        const got = big(ev.sharesOut);
        expect(got > 0n, `${where}: bought nothing`).to.equal(true);
        if (step.side === "yes") t.yes += got;
        else t.no += got;
        ledger.in(step.amount!);
      } else {
        const held = step.side === "yes" ? t.yes : t.no;
        const shares = (held * BigInt(step.pct!)) / 100n;
        expect(shares > 0n, `${where}: nothing to sell`).to.equal(true);
        const tx = await rpcWithEvents(
          program,
          program.methods
            .sellShares(outcomeArg(step.side), bn(shares), bn(0))
            .accountsPartial({
              seller: t.keypair.publicKey,
              market: fx.market,
              position: t.position,
              vault: fx.vault,
              sellerTokenAccount: t.tokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            }),
          [t.keypair]
        );
        const ev = requireEvent(tx, "sharesSold");
        const proceeds = big(ev.collateralOut);
        if (step.side === "yes") t.yes -= shares;
        else t.no -= shares;
        ledger.out(proceeds);
      }

      const { vault, market } = await assertSolvent(program, fx, ledger, where);
      await assertPositionsSumToQ(where);
      const cover = vault - maxBig(market.qYes, market.qNo);
      minCover = minCover === null || cover < minCover ? cover : minCover;
    }

    // ---- resolution ----
    await waitForOnChainTime(fx.closeTime);
    await rpcWithEvents(
      program,
      program.methods.closeMarket().accountsPartial({ market: fx.market })
    );
    await assertSolvent(program, fx, ledger, `${label} after close`);

    await rpcWithEvents(
      program,
      program.methods
        .resolveMarket(outcomeArg(winning))
        .accountsPartial({ market: fx.market, resolver: fx.resolver.publicKey }),
      [fx.resolver]
    );

    const atResolution = await readMarket(program, fx.market);
    expect(atResolution.winningOutcome).to.equal(winning);
    const obligation = winning === "yes" ? atResolution.qYes : atResolution.qNo;
    const vaultAtResolution = await tokenBalance(fx.vault);
    expect(
      vaultAtResolution >= obligation,
      `${label}: vault ${vaultAtResolution} cannot cover the winning side ${obligation}`
    ).to.equal(true);
    expect(obligation > 0n, `${label}: the winning side ended empty`).to.equal(true);

    // ---- everyone redeems ----
    let paid = 0n;
    for (const t of traders) {
      const expected = winning === "yes" ? t.yes : t.no;
      const isEmpty = t.yes === 0n && t.no === 0n;
      const walletBefore = await tokenBalance(t.tokenAccount);

      if (isEmpty) {
        // A trader who unwound completely still owns a live (0/0) position -
        // `sell_shares` deliberately does not close it. `redeem` refuses it
        // with NothingToRedeem; negative.ts asserts that code directly.
        expect(await positionExists(t.position)).to.equal(true);
        continue;
      }

      const tx = await rpcWithEvents(
        program,
        program.methods.redeem().accountsPartial({
          owner: t.keypair.publicKey,
          market: fx.market,
          position: t.position,
          vault: fx.vault,
          ownerTokenAccount: t.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [t.keypair]
      );
      const payout = big(requireEvent(tx, "redeemed").payout);
      expect(payout.toString(), `${label}: ${t.name} payout != winning shares`).to.equal(
        expected.toString()
      );
      const walletAfter = await tokenBalance(t.tokenAccount);
      expect((walletAfter - walletBefore).toString()).to.equal(payout.toString());
      expect(await positionExists(t.position), `${label}: ${t.name} position not closed`).to.equal(
        false
      );
      ledger.out(payout);
      paid += payout;
      await assertSolvent(program, fx, ledger, `${label} after ${t.name} redeems`);
    }

    const residual = await tokenBalance(fx.vault);
    // Every claimant was paid; only holders with a live 0/0 position are left,
    // and they are owed nothing.
    expect(paid.toString(), `${label}: total paid != winning-side supply`).to.equal(
      obligation.toString()
    );
    expect(residual >= 0n, `${label}: vault went negative`).to.equal(true);
    expect(residual.toString()).to.equal((fx.seed + ledger.inflow - ledger.outflow).toString());

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        `  ---- concurrency (${label}) ----`,
        `  users                    = ${traders.length}, trades = ${SCRIPT.length}`,
        `  b / seed                 = ${fx.b} / ${fx.seed}`,
        `  collateral in / out      = ${ledger.inflow} / ${ledger.outflow}`,
        `  q_yes / q_no at resolve  = ${atResolution.qYes} / ${atResolution.qNo}`,
        `  winning side             = ${winning}  (obligation ${obligation})`,
        `  vault at resolution      = ${vaultAtResolution}`,
        `  total paid to winners    = ${paid}`,
        `  residual                 = ${residual}`,
        `  tightest cover during trading (vault - max(q_yes,q_no)) = ${minCover}`,
        "",
      ].join("\n")
    );
  }

  it("YES resolution: 5 users, interleaved trades, solvent at every step", async function () {
    this.timeout(900_000);
    await runMarket("yes", "yes-wins");
  });

  it("NO resolution: the same script, the other obligation", async function () {
    this.timeout(900_000);
    await runMarket("no", "no-wins");
  });
});
