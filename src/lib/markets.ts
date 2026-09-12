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
 *
 * ## Resolution redaction
 *
 * A pending verdict — and the photo it was read from — tells a trader the
 * answer before the market settles. So until the market is resolved on chain,
 * only the group owner receives the full `ResolutionRecord` and the photo/AI
 * fields; everyone else gets `{ redacted: true, status, submittedBy,
 * submittedAt }`. See `docs/resolver/PLAN-2-validate-settle.md`, decision 4.
 */

import { after } from "next/server";

import type {
  Market,
  MarketStatus,
  MarketView,
  Position,
  ResolutionView,
  Side,
  Trade,
  User,
} from "@/types";
import { priceToProb } from "@/lib/chain/config";
import type { ChainMarket } from "@/lib/chain/projection";
import { db } from "@/lib/store";
import { formatProb, winningShares } from "@/lib/market-display";
import { isSettleDue, settleMarket } from "@/lib/resolver/settle";

export { formatProb, winningShares };

/** Fields that reveal the pending answer; stripped for non-owners pre-resolution. */
type RevealingFields =
  | "resolution"
  | "resolutionImageUrl"
  | "resolutionNote"
  | "aiDescription"
  | "aiModel"
  | "aiPrediction"
  | "aiConfidence";

/**
 * The market metadata as this viewer may see it.
 *
 * Built by destructuring rather than spreading `market`, so the raw record can
 * never leak through `...market`.
 */
function redactFor(
  market: Market,
  chain: ChainMarket | undefined,
  viewerWallet: string | undefined,
  groupOwnerId: string,
): Omit<Market, RevealingFields> & Pick<MarketView, RevealingFields> {
  const {
    resolution,
    resolutionImageUrl,
    resolutionNote,
    aiDescription,
    aiModel,
    aiPrediction,
    aiConfidence,
    ...rest
  } = market;

  // `viewerWallet` may be "" for a user without a wallet — never match on that.
  const isOwner =
    Boolean(viewerWallet) &&
    db.getUserByWallet(viewerWallet!)?.id === groupOwnerId;
  const revealed = isOwner || chain?.status === "resolved";

  if (revealed) {
    const view: ResolutionView | undefined = resolution
      ? { redacted: false, ...resolution }
      : undefined;
    return {
      ...rest,
      resolution: view,
      resolutionImageUrl,
      resolutionNote,
      aiDescription,
      aiModel,
      aiPrediction,
      aiConfidence,
    };
  }

  return {
    ...rest,
    resolution: resolution
      ? {
          redacted: true,
          status: resolution.status,
          submittedBy: resolution.submittedBy,
          submittedAt: resolution.submittedAt,
        }
      : undefined,
  };
}

/**
 * Join off-chain metadata to on-chain state.
 *
 * `chain` is undefined when the market exists in the store but the indexer has
 * not caught up — which is the normal state for a few seconds after creation,
 * since the indexer polls. The view then reports `indexed: false` and the UI
 * shows it as pending rather than inventing prices for it.
 *
 * `viewerWallet` decides both `myPosition` and resolution redaction: omit it
 * and the view is redacted as for a non-owner.
 */
export function toMarketView(
  market: Market,
  chain: ChainMarket | undefined,
  viewerWallet?: string,
): MarketView {
  const groupOwnerId = db.getGroup(market.groupId)?.ownerId ?? market.createdBy;
  const meta = redactFor(market, chain, viewerWallet, groupOwnerId);

  if (!chain) {
    return {
      ...meta,
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
      groupOwnerId,
    };
  }

  const yesProb = priceToProb(chain.priceYes);
  const myPosition: Position | undefined = viewerWallet
    ? toPosition(chain, viewerWallet)
    : undefined;

  return {
    ...meta,
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
    groupOwnerId,
  };
}

/**
 * Lazy settlement trigger for read routes: for every market whose resolution
 * is due, settle it after the response is sent. Never awaited in the request;
 * `settleMarket` never throws and dedupes concurrent calls per market.
 *
 * Must be called inside a request (route handler) — `after` needs one.
 */
export function scheduleDueSettlements(
  markets: Market[],
  chainFor: (address: string) => ChainMarket | undefined,
): void {
  const now = Date.now();
  for (const market of markets) {
    if (!isSettleDue(market, chainFor(market.address), now)) continue;
    const id = market.address;
    after(() => settleMarket(id));
  }
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

export type { User };
