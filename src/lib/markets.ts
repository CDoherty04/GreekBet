/**
 * Market view assembly.
 *
 * ## The parimutuel model is gone
 *
 * This file previously implemented parimutuel pool betting: stakes went into a
 * pot and the winning side split it proportionally, with odds derived from the
 * ratio of money already staked.
 *
 * Markets are now **LMSR automated market makers on Solana**, and the two are
 * different products rather than two implementations of one:
 *
 * | | parimutuel (before) | LMSR (now) |
 * |---|---|---|
 * | price | ratio of staked money | bonding curve, set by the maker |
 * | exit before resolution | impossible | sell back at the current price |
 * | who is at risk | only the bettors | the creator subsidises `b·ln2` |
 * | settlement | split the pot | winning shares redeem 1:1 |
 * | custody | the app's ledger | a program-owned vault |
 *
 * So `computePool` and `computePayouts` were removed rather than adapted —
 * there is nothing left for them to compute. Pricing comes from the chain via
 * the indexer, and payouts are the program's business.
 */

import type {
  Market,
  MarketStatus,
  MarketView,
  Position,
  Side,
  Trade,
  User,
} from "@/types";
import { priceToProb } from "@/lib/chain/config";
import type { ChainMarket } from "@/lib/chain/projection";
import { db } from "@/lib/store";

/** Human-friendly odds label, e.g. "62%". */
export function formatProb(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

/**
 * Join off-chain metadata to on-chain state.
 *
 * `chain` is undefined when the market exists in the store but the indexer has
 * not caught up — which is the normal state for a few seconds after creation,
 * since the indexer polls. The view then reports `indexed: false` and the UI
 * shows it as pending rather than inventing prices for it.
 */
export function toMarketView(
  market: Market,
  chain: ChainMarket | undefined,
  viewerWallet?: string,
): MarketView {
  if (!chain) {
    return {
      ...market,
      status: "open",
      expiresAt: 0,
      pricing: {
        yesProb: 0.5,
        noProb: 0.5,
        qYes: "0",
        qNo: "0",
        b: "0",
        seedAmount: "0",
        volume: "0",
      },
      trades: [],
      indexed: false,
    };
  }

  const yesProb = priceToProb(chain.priceYes);
  const myPosition: Position | undefined = viewerWallet
    ? toPosition(chain, viewerWallet)
    : undefined;

  return {
    ...market,
    status: chain.status as MarketStatus,
    // The program works in unix seconds; the UI in milliseconds.
    expiresAt: chain.closeTime * 1000,
    outcome: chain.winningOutcome,
    pricing: {
      yesProb,
      noProb: 1 - yesProb,
      qYes: chain.qYes,
      qNo: chain.qNo,
      b: chain.b,
      seedAmount: chain.seedAmount,
      volume: chain.volume,
    },
    trades: chain.trades.map(toTrade),
    myPosition,
    indexed: true,
  };
}

function toPosition(chain: ChainMarket, wallet: string): Position | undefined {
  const p = chain.positions[wallet];
  if (!p) return undefined;
  return {
    yesShares: p.yesShares,
    noShares: p.noShares,
    payout: p.payout,
    redeemed: p.redeemed,
  };
}

/** Attach display names by resolving wallet addresses back to users. */
function toTrade(t: ChainMarket["trades"][number]): Trade {
  const user = db.getUserByWallet(t.user);
  return {
    signature: t.signature,
    slot: t.slot,
    blockTime: t.blockTime,
    user: t.user,
    userName: user?.name,
    userAvatarUrl: user?.avatarUrl,
    side: t.outcome as Side,
    isBuy: t.isBuy,
    collateral: t.collateral,
    shares: t.shares,
  };
}

/** Shares a user holds on the winning side, or "0". */
export function winningShares(view: MarketView): string {
  if (!view.outcome || !view.myPosition) return "0";
  return view.outcome === "yes"
    ? view.myPosition.yesShares
    : view.myPosition.noShares;
}

export type { User };
