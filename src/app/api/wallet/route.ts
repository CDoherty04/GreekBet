/**
 * /api/wallet — the signed-in user's on-chain balances.
 *
 * Replaces the internal play-token balance. Two numbers matter and they fail
 * differently, so both are returned:
 *
 * * **USDC** is what trades are denominated in. Zero means "cannot trade".
 * * **SOL** pays transaction fees and account rent. Zero means "cannot do
 *   anything at all", and it fails with an error from deep inside the runtime
 *   that says nothing about needing SOL — so the UI needs to know before the
 *   user finds out the hard way.
 */

import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { connection } from "@/lib/chain/program";
import { COLLATERAL_MINT } from "@/lib/chain/config";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return ok({ sol: "0", usdc: "0", address: "" });

  const owner = new PublicKey(user.walletAddress);
  const conn = connection();

  const lamports = await conn.getBalance(owner).catch(() => 0);

  // A missing token account is the normal state before a first deposit, not an
  // error — it is created lazily on the user's first trade.
  let usdc = "0";
  try {
    const ata = await getAssociatedTokenAddress(COLLATERAL_MINT, owner, true);
    const account = await getAccount(conn, ata);
    usdc = account.amount.toString();
  } catch {
    usdc = "0";
  }

  return ok({
    sol: lamports.toString(),
    usdc,
    address: user.walletAddress,
  });
}
