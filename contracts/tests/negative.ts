/**
 * tests/negative.ts - every failure path, asserted by **specific error code**.
 *
 * `expectError` fails the test if the call succeeds *or* if it fails with any
 * code other than the one named. A test that merely observes "it threw" is
 * worthless here: most of these conditions are reachable by several routes and
 * several of them would otherwise be satisfied by an unrelated bug (a wrong
 * PDA, an unfunded wallet, a missing signer).
 *
 * ## Two traps this file exists to pin down
 *
 * 1. **A second `redeem` fails with Anchor's `AccountNotInitialized` (3012),
 *    not with `NothingToRedeem` (6017).** `redeem` carries `close = owner` on
 *    the position, so by the second call the account is gone and
 *    deserialisation fails before the handler runs. `NothingToRedeem` is still
 *    reachable, but only through a position that *exists* and holds 0/0 - a
 *    trader who sold their entire holding before resolution. Both are tested,
 *    separately, because they are different guarantees: one is "cannot be paid
 *    twice", the other is "cannot redeem nothing".
 * 2. **A market past `close_time` reports `MarketNotOpen`, not
 *    `CloseTimeNotReached`.** `close_market` is a bookkeeping crank, not the
 *    trading boundary: `buy_shares` / `sell_shares` check the clock themselves,
 *    so trading stops at `close_time` whether or not anyone cranked.
 *    `CloseTimeNotReached` means the opposite thing - a crank that arrived too
 *    early.
 */

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  assertIdlErrorCodesMatch,
  B_MAX,
  B_MIN,
  bLn2Floor,
  big,
  bn,
  Collateral,
  createCollateralMint,
  createMarketFixture,
  deriveMarket,
  derivePosition,
  deriveVault,
  ERR,
  expectError,
  fundedKeypair,
  fundedTrader,
  getProgram,
  LANG_ERR,
  MarketFixture,
  MAX_QUESTION_LEN,
  onChainUnixTime,
  outcomeArg,
  positionExists,
  readMarket,
  readPosition,
  requireEvent,
  rpcWithEvents,
  Side,
  tokenAccountFor,
  tokenBalance,
  uniqueQuestion,
  waitForOnChainTime,
} from "./utils";

describe("negative: every failure path fails with its own error code", () => {
  const program = getProgram();
  const B = 100_000_000n;
  const FUNDING = 1_000_000_000n;

  let collateral: Collateral;
  let otherMint: Collateral; // same 6 decimals, different mint -> InvalidMint
  let nineDecimalMint: Collateral; // -> InvalidMintDecimals

  // A long-lived open market for everything that does not need a lifecycle.
  let open: MarketFixture;
  let trader: { keypair: Keypair; tokenAccount: PublicKey };
  let traderPos: PublicKey;

  before(async function () {
    this.timeout(600_000);
    assertIdlErrorCodesMatch(program);
    collateral = await createCollateralMint();
    otherMint = await createCollateralMint();
    nineDecimalMint = await createCollateralMint(9);

    open = await createMarketFixture(collateral, { b: B, closeTimeSecondsFromNow: 3600 });
    trader = await fundedTrader(collateral, FUNDING);
    traderPos = derivePosition(program.programId, open.market, trader.keypair.publicKey)[0];

    // Seed a real position so the sell-side negatives have something to hit.
    await rpcWithEvents(
      program,
      program.methods.buyShares(outcomeArg("yes"), bn(20_000_000n), bn(0)).accountsPartial({
        buyer: trader.keypair.publicKey,
        market: open.market,
        position: traderPos,
        vault: open.vault,
        buyerTokenAccount: trader.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [trader.keypair]
    );
  });

  // -------------------------------------------------------------------------
  // create_market
  // -------------------------------------------------------------------------

  async function createRaw(opts: {
    b: bigint;
    closeTime: number;
    question?: string;
    mint?: Collateral;
  }): Promise<void> {
    const mint = opts.mint ?? collateral;
    const creator = await fundedKeypair(20);
    const creatorTokenAccount = await tokenAccountFor(mint, creator.publicKey);
    const question = opts.question ?? uniqueQuestion("negative create");
    const [market] = deriveMarket(program.programId, creator.publicKey, question);
    const [vault] = deriveVault(program.programId, market);
    await program.methods
      .createMarket(question, bn(opts.closeTime), bn(opts.b), Keypair.generate().publicKey)
      .accountsPartial({
        creator: creator.publicKey,
        market,
        collateralMint: mint.mint,
        vault,
        creatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
  }

  it("create_market with b below B_MIN -> BOutOfRange", async function () {
    this.timeout(120_000);
    const closeTime = (await onChainUnixTime()) + 3600;
    await expectError(
      createRaw({ b: B_MIN - 1n, closeTime }),
      ERR.BOutOfRange,
      "b = B_MIN - 1"
    );
    await expectError(createRaw({ b: 0n, closeTime }), ERR.BOutOfRange, "b = 0");
  });

  it("create_market with b above B_MAX -> BOutOfRange", async function () {
    this.timeout(120_000);
    const closeTime = (await onChainUnixTime()) + 3600;
    await expectError(
      createRaw({ b: B_MAX + 1n, closeTime }),
      ERR.BOutOfRange,
      "b = B_MAX + 1"
    );
  });

  it("create_market with close_time in the past -> CloseTimeInPast", async function () {
    this.timeout(120_000);
    const now = await onChainUnixTime();
    await expectError(
      createRaw({ b: B, closeTime: now - 60 }),
      ERR.CloseTimeInPast,
      "close_time 60s ago"
    );
    // The boundary is strict: `close_time > now` is required, so "now" fails.
    await expectError(
      createRaw({ b: B, closeTime: now }),
      ERR.CloseTimeInPast,
      "close_time == now"
    );
  });

  it("create_market with an over-long question -> QuestionTooLong", async function () {
    this.timeout(120_000);
    const closeTime = (await onChainUnixTime()) + 3600;
    await expectError(
      createRaw({ b: B, closeTime, question: "q".repeat(MAX_QUESTION_LEN + 1) }),
      ERR.QuestionTooLong,
      "201-byte question"
    );
  });

  it("create_market with a non-6-decimal mint -> InvalidMintDecimals", async function () {
    this.timeout(120_000);
    const closeTime = (await onChainUnixTime()) + 3600;
    await expectError(
      createRaw({ b: B, closeTime, mint: nineDecimalMint }),
      ERR.InvalidMintDecimals,
      "9-decimal collateral mint"
    );
  });

  // -------------------------------------------------------------------------
  // buy_shares / sell_shares
  // -------------------------------------------------------------------------

  function buy(
    fx: MarketFixture,
    who: Keypair,
    tokenAccount: PublicKey,
    position: PublicKey,
    side: Side,
    amount: bigint,
    minSharesOut: bigint,
    overrides: Record<string, PublicKey> = {}
  ): Promise<string> {
    return program.methods
      .buyShares(outcomeArg(side), bn(amount), bn(minSharesOut))
      .accountsPartial({
        buyer: who.publicKey,
        market: fx.market,
        position,
        vault: fx.vault,
        buyerTokenAccount: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ...overrides,
      })
      .signers([who])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
  }

  function sell(
    fx: MarketFixture,
    who: Keypair,
    tokenAccount: PublicKey,
    position: PublicKey,
    side: Side,
    shares: bigint,
    minUsdcOut: bigint,
    overrides: Record<string, PublicKey> = {}
  ): Promise<string> {
    return program.methods
      .sellShares(outcomeArg(side), bn(shares), bn(minUsdcOut))
      .accountsPartial({
        seller: who.publicKey,
        market: fx.market,
        position,
        vault: fx.vault,
        sellerTokenAccount: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .signers([who])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
  }

  /** Snapshot everything a failed trade must leave untouched. */
  async function snapshot(fx: MarketFixture, tokenAccount: PublicKey, position: PublicKey) {
    const m = await readMarket(program, fx.market);
    const p = (await positionExists(position))
      ? await readPosition(program, position)
      : { yesShares: -1n, noShares: -1n };
    return {
      qYes: m.qYes,
      qNo: m.qNo,
      vault: await tokenBalance(fx.vault),
      wallet: await tokenBalance(tokenAccount),
      yes: p.yesShares,
      no: p.noShares,
    };
  }

  it("buy with unsatisfiable slippage -> SlippageExceeded, and nothing changed", async function () {
    this.timeout(120_000);
    const before = await snapshot(open, trader.tokenAccount, traderPos);

    // 1 USDC cannot possibly buy 1e12 base units of shares at this state.
    await expectError(
      buy(open, trader.keypair, trader.tokenAccount, traderPos, "yes", 1_000_000n, 10n ** 12n),
      ERR.SlippageExceeded,
      "buy with min_shares_out far above achievable"
    );

    const after = await snapshot(open, trader.tokenAccount, traderPos);
    expect(after, "a failed buy changed state").to.deep.equal(before);
  });

  it("sell with min_usdc_out above achievable -> SlippageExceeded, and nothing changed", async function () {
    this.timeout(120_000);
    const before = await snapshot(open, trader.tokenAccount, traderPos);
    const pos = await readPosition(program, traderPos);

    await expectError(
      sell(
        open,
        trader.keypair,
        trader.tokenAccount,
        traderPos,
        "yes",
        pos.yesShares / 2n,
        10n ** 12n
      ),
      ERR.SlippageExceeded,
      "sell with min_usdc_out far above achievable"
    );

    const after = await snapshot(open, trader.tokenAccount, traderPos);
    expect(after, "a failed sell changed state").to.deep.equal(before);
  });

  it("sell more shares than held -> InsufficientShares", async function () {
    this.timeout(120_000);
    const pos = await readPosition(program, traderPos);
    await expectError(
      sell(open, trader.keypair, trader.tokenAccount, traderPos, "yes", pos.yesShares + 1n, 0n),
      ERR.InsufficientShares,
      "sell one more share than held"
    );
    // ...and the side they hold nothing of at all.
    await expectError(
      sell(open, trader.keypair, trader.tokenAccount, traderPos, "no", 1n, 0n),
      ERR.InsufficientShares,
      "sell a side with a zero holding"
    );
  });

  it("zero-amount trades -> ZeroCostTrade in both directions", async function () {
    this.timeout(120_000);
    // A deliberate divergence from the reference oracle, which permits both
    // (reference/README.md, "Behaviours T04/T07 should expect", item 1).
    await expectError(
      buy(open, trader.keypair, trader.tokenAccount, traderPos, "yes", 0n, 0n),
      ERR.ZeroCostTrade,
      "buy with usdc_amount = 0"
    );
    await expectError(
      sell(open, trader.keypair, trader.tokenAccount, traderPos, "yes", 0n, 0n),
      ERR.ZeroCostTrade,
      "sell with share_amount = 0"
    );
  });

  it("a token account of the wrong mint -> InvalidMint", async function () {
    this.timeout(120_000);
    const wrong = await tokenAccountFor(otherMint, trader.keypair.publicKey);
    await expectError(
      buy(open, trader.keypair, wrong, traderPos, "yes", 1_000_000n, 0n),
      ERR.InvalidMint,
      "buy with a token account on a different (but also 6-decimal) mint"
    );
    await expectError(
      sell(open, trader.keypair, wrong, traderPos, "yes", 1_000_000n, 0n),
      ERR.InvalidMint,
      "sell into a token account on a different mint"
    );
  });

  it("a fake vault -> InvalidVault", async function () {
    this.timeout(120_000);
    // A perfectly valid token account for the *right* mint - it is simply not
    // the pubkey the market stored at creation.
    const impostor = await tokenAccountFor(collateral, Keypair.generate().publicKey);
    await expectError(
      buy(open, trader.keypair, trader.tokenAccount, traderPos, "yes", 1_000_000n, 0n, {
        vault: impostor,
      }),
      ERR.InvalidVault,
      "buy against a substituted vault"
    );
    await expectError(
      sell(open, trader.keypair, trader.tokenAccount, traderPos, "yes", 1_000_000n, 0n, {
        vault: impostor,
      }),
      ERR.InvalidVault,
      "sell against a substituted vault"
    );
  });

  it("a buy that would push q past MAX_Q -> QOutOfRange", async function () {
    this.timeout(300_000);
    // At B_MIN the price is pinned near 1 once the book is deep, so spending
    // ~1.2e15 base units buys past the 1e15 cap in a single trade. The crate
    // returns the unclamped mathematical answer on purpose; enforcing the cap
    // is the program's job (reference/README.md, item 2).
    const fx = await createMarketFixture(collateral, {
      b: B_MIN,
      closeTimeSecondsFromNow: 3600,
      creatorFunding: bLn2Floor(B_MIN) * 4n,
    });
    const whale = await fundedTrader(collateral, 3_000_000_000_000_000n);
    const [pos] = derivePosition(program.programId, fx.market, whale.keypair.publicKey);
    await expectError(
      buy(fx, whale.keypair, whale.tokenAccount, pos, "yes", 1_200_000_000_000_000n, 0n),
      ERR.QOutOfRange,
      "a buy larger than MAX_Q"
    );
    // The market is untouched by the rejected trade.
    const m = await readMarket(program, fx.market);
    expect(m.qYes.toString()).to.equal("0");
  });

  // -------------------------------------------------------------------------
  // close_market / resolve_market ordering
  // -------------------------------------------------------------------------

  it("close_market before close_time -> CloseTimeNotReached", async function () {
    this.timeout(120_000);
    await expectError(
      program.methods
        .closeMarket()
        .accountsPartial({ market: open.market })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      ERR.CloseTimeNotReached,
      "crank an hour early"
    );
    expect((await readMarket(program, open.market)).status).to.equal("open");
  });

  it("resolve_market before close_market -> MarketNotClosed", async function () {
    this.timeout(120_000);
    await expectError(
      program.methods
        .resolveMarket(outcomeArg("yes"))
        .accountsPartial({ market: open.market, resolver: open.resolver.publicKey })
        .signers([open.resolver])
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      ERR.MarketNotClosed,
      "resolve while still open"
    );
  });

  it("redeem before resolution -> MarketNotResolved", async function () {
    this.timeout(120_000);
    await expectError(
      program.methods
        .redeem()
        .accountsPartial({
          owner: trader.keypair.publicKey,
          market: open.market,
          position: traderPos,
          vault: open.vault,
          ownerTokenAccount: trader.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader.keypair])
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      ERR.MarketNotResolved,
      "redeem an open market"
    );
  });

  // -------------------------------------------------------------------------
  // A market taken through its whole lifecycle for the post-close negatives.
  // -------------------------------------------------------------------------

  describe("after close and resolution", () => {
    let fx: MarketFixture;
    // `winner` holds YES and wins. `loser` holds NO. `flat` bought YES and
    // sold all of it back before resolution, so their position still exists
    // (only `redeem` closes one) and holds 0/0 - the NothingToRedeem case.
    let winner: { keypair: Keypair; tokenAccount: PublicKey };
    let loser: { keypair: Keypair; tokenAccount: PublicKey };
    let flat: { keypair: Keypair; tokenAccount: PublicKey };
    let posWinner: PublicKey;
    let posLoser: PublicKey;
    let posFlat: PublicKey;

    before(async function () {
      this.timeout(600_000);
      fx = await createMarketFixture(collateral, { b: B, closeTimeSecondsFromNow: 25 });
      winner = await fundedTrader(collateral, FUNDING);
      loser = await fundedTrader(collateral, FUNDING);
      flat = await fundedTrader(collateral, FUNDING);
      posWinner = derivePosition(program.programId, fx.market, winner.keypair.publicKey)[0];
      posLoser = derivePosition(program.programId, fx.market, loser.keypair.publicKey)[0];
      posFlat = derivePosition(program.programId, fx.market, flat.keypair.publicKey)[0];

      await buy(fx, winner.keypair, winner.tokenAccount, posWinner, "yes", 15_000_000n, 0n);
      await buy(fx, loser.keypair, loser.tokenAccount, posLoser, "no", 6_000_000n, 0n);
      await buy(fx, flat.keypair, flat.tokenAccount, posFlat, "yes", 8_000_000n, 0n);

      // `flat` unwinds completely. `sell_shares` does NOT close the account -
      // that is what makes NothingToRedeem reachable at all.
      const held = (await readPosition(program, posFlat)).yesShares;
      await sell(fx, flat.keypair, flat.tokenAccount, posFlat, "yes", held, 0n);
      const after = await readPosition(program, posFlat);
      expect(after.yesShares.toString()).to.equal("0");
      expect(after.noShares.toString()).to.equal("0");
      expect(await positionExists(posFlat), "sell_shares closed the position").to.equal(true);

      await waitForOnChainTime(fx.closeTime);
    });

    it("buy after close_time (before the crank) -> MarketNotOpen", async function () {
      this.timeout(120_000);
      expect((await readMarket(program, fx.market)).status).to.equal("open");
      await expectError(
        buy(fx, winner.keypair, winner.tokenAccount, posWinner, "yes", 1_000_000n, 0n),
        ERR.MarketNotOpen,
        "buy past close_time on an uncranked market"
      );
    });

    it("close_market succeeds once, and a second crank -> MarketNotOpen", async function () {
      this.timeout(120_000);
      await rpcWithEvents(
        program,
        program.methods.closeMarket().accountsPartial({ market: fx.market })
      );
      expect((await readMarket(program, fx.market)).status).to.equal("closed");
      await expectError(
        program.methods
          .closeMarket()
          .accountsPartial({ market: fx.market })
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        ERR.MarketNotOpen,
        "close an already-closed market"
      );
    });

    it("buy and sell after close_market -> MarketNotOpen", async function () {
      this.timeout(120_000);
      await expectError(
        buy(fx, winner.keypair, winner.tokenAccount, posWinner, "yes", 1_000_000n, 0n),
        ERR.MarketNotOpen,
        "buy on a closed market"
      );
      await expectError(
        sell(fx, winner.keypair, winner.tokenAccount, posWinner, "yes", 1_000_000n, 0n),
        ERR.MarketNotOpen,
        "sell on a closed market"
      );
    });

    it("resolve_market from a non-authority signer -> Unauthorized", async function () {
      this.timeout(120_000);
      const impostor = await fundedKeypair(5);
      await expectError(
        program.methods
          .resolveMarket(outcomeArg("no"))
          .accountsPartial({ market: fx.market, resolver: impostor.publicKey })
          .signers([impostor])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        ERR.Unauthorized,
        "resolve as a stranger"
      );
      // Also: the market creator is not the resolver either.
      await expectError(
        program.methods
          .resolveMarket(outcomeArg("no"))
          .accountsPartial({ market: fx.market, resolver: fx.creator.publicKey })
          .signers([fx.creator])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        ERR.Unauthorized,
        "resolve as the creator"
      );
      expect((await readMarket(program, fx.market)).status).to.equal("closed");
    });

    it("resolve_market twice -> MarketAlreadyResolved", async function () {
      this.timeout(120_000);
      await rpcWithEvents(
        program,
        program.methods
          .resolveMarket(outcomeArg("yes"))
          .accountsPartial({ market: fx.market, resolver: fx.resolver.publicKey }),
        [fx.resolver]
      );
      const m = await readMarket(program, fx.market);
      expect(m.status).to.equal("resolved");
      expect(m.winningOutcome).to.equal("yes");

      await expectError(
        program.methods
          .resolveMarket(outcomeArg("no"))
          .accountsPartial({ market: fx.market, resolver: fx.resolver.publicKey })
          .signers([fx.resolver])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        ERR.MarketAlreadyResolved,
        "resolve a second time"
      );
      // The first answer stands.
      expect((await readMarket(program, fx.market)).winningOutcome).to.equal("yes");
    });

    it("redeem on an emptied-but-existing position -> NothingToRedeem", async function () {
      this.timeout(120_000);
      expect(await positionExists(posFlat)).to.equal(true);
      const before = await tokenBalance(flat.tokenAccount);
      await expectError(
        program.methods
          .redeem()
          .accountsPartial({
            owner: flat.keypair.publicKey,
            market: fx.market,
            position: posFlat,
            vault: fx.vault,
            ownerTokenAccount: flat.tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([flat.keypair])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        ERR.NothingToRedeem,
        "redeem a 0/0 position"
      );
      expect((await tokenBalance(flat.tokenAccount)).toString()).to.equal(before.toString());
      // The failed redeem did not close the account either.
      expect(await positionExists(posFlat)).to.equal(true);
    });

    it("redeem twice -> AccountNotInitialized (3012), and no double payment", async function () {
      this.timeout(120_000);
      const shares = (await readPosition(program, posWinner)).yesShares;
      const walletBefore = await tokenBalance(winner.tokenAccount);
      const vaultBefore = await tokenBalance(fx.vault);

      const tx = await rpcWithEvents(
        program,
        program.methods.redeem().accountsPartial({
          owner: winner.keypair.publicKey,
          market: fx.market,
          position: posWinner,
          vault: fx.vault,
          ownerTokenAccount: winner.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [winner.keypair]
      );
      const payout = big(requireEvent(tx, "redeemed").payout);
      expect(payout.toString()).to.equal(shares.toString());
      expect(await positionExists(posWinner)).to.equal(false);

      const walletAfterFirst = await tokenBalance(winner.tokenAccount);
      const vaultAfterFirst = await tokenBalance(fx.vault);

      // The second call cannot reach the handler: `close = owner` drained and
      // zeroed the account, so Anchor's deserialisation fails first. This is
      // 3012, NOT 6017 - a distinction worth pinning, because a test that only
      // asserted "it failed" would not notice if the close were removed.
      await expectError(
        program.methods
          .redeem()
          .accountsPartial({
            owner: winner.keypair.publicKey,
            market: fx.market,
            position: posWinner,
            vault: fx.vault,
            ownerTokenAccount: winner.tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([winner.keypair])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        LANG_ERR.AccountNotInitialized,
        "redeem a second time"
      );

      expect(
        (await tokenBalance(winner.tokenAccount)).toString(),
        "the second redeem paid out"
      ).to.equal(walletAfterFirst.toString());
      expect((await tokenBalance(fx.vault)).toString(), "the vault paid twice").to.equal(
        vaultAfterFirst.toString()
      );
      expect(walletAfterFirst - walletBefore).to.equal(payout);
      expect(vaultBefore - vaultAfterFirst).to.equal(payout);
    });

    it("redeem someone else's position -> the position PDA constraint rejects it", async function () {
      this.timeout(120_000);
      // `loser` signing against `posLoser` is legitimate; signing against
      // another owner's PDA is not, and the seeds are derived from
      // `owner.key()`, so the address simply does not match.
      const thief = await fundedKeypair(5);
      const thiefTokenAccount = await tokenAccountFor(collateral, thief.publicKey);
      const caught = await expectError(
        program.methods
          .redeem()
          .accountsPartial({
            owner: thief.publicKey,
            market: fx.market,
            position: posLoser,
            vault: fx.vault,
            ownerTokenAccount: thiefTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([thief])
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
        LANG_ERR.ConstraintSeeds,
        "redeem another owner's position"
      );
      expect(caught).to.not.equal(undefined);
      expect(await positionExists(posLoser)).to.equal(true);
    });
  });
});
