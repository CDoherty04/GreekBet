"use client";

/**
 * On-chain balance pill.
 *
 * Shows real USDC, not an internal play-token balance — trades settle against
 * a Solana vault now, so a second in-app number would diverge the moment
 * anything moved.
 *
 * It also warns when the wallet has no SOL. That failure is worth surfacing
 * early: without SOL for fees and rent, every action fails with a message from
 * deep inside the runtime that never mentions SOL.
 */

import { useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/chain/config";

export function BalancePill() {
  const { user } = useSession();
  const [balance, setBalance] = useState<{ sol: string; usdc: string } | null>(
    null,
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = () =>
      api
        .getBalance()
        .then((b) => {
          if (!cancelled) setBalance({ sol: b.sol, usdc: b.usdc });
        })
        .catch(() => {});
    void load();
    // Balances change as a side effect of trading, and the RPC read is cheap
    // next to a trade, so poll rather than threading invalidation everywhere.
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user]);

  if (!user) return null;

  const noSol = balance !== null && balance.sol === "0";

  return (
    <div
      className={[
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-display text-sm font-bold tracking-wide",
        noSol
          ? "border-no/40 bg-no/10 text-no"
          : "border-brand/30 bg-brand/10 text-brand",
      ].join(" ")}
      title={noSol ? "This wallet has no devnet SOL for fees" : undefined}
    >
      {balance ? `$${formatUnits(balance.usdc)}` : "…"}
      {noSol && <span className="text-[10px] font-normal">no SOL</span>}
    </div>
  );
}
