"use client";

/**
 * On-chain balance pill.
 *
 * Shows collateral balance for the signed-in Privy wallet. When empty, it
 * auto-claims a one-shot devnet top-up from the project treasury so new
 * accounts can create markets without a manual faucet step.
 */

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/chain/config";

export function BalancePill() {
  const { user } = useSession();
  const [balance, setBalance] = useState<{ sol: string; usdc: string } | null>(
    null,
  );
  const funding = useRef(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const load = async () => {
      try {
        let b = await api.getBalance();
        const empty = b.sol === "0" || b.usdc === "0";
        if (empty && !funding.current) {
          funding.current = true;
          try {
            await api.fundWallet();
            b = await api.getBalance();
          } catch {
            /* treasury may be dry — pill stays at $0 */
          }
        }
        if (!cancelled) setBalance({ sol: b.sol, usdc: b.usdc });
      } catch {
        /* ignore */
      }
    };

    void load();
    const t = setInterval(() => void load(), 15000);
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
