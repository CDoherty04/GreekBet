"use client";

/**
 * Profile — copy address, balances, send USDC via Privy, sign out.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/TextField";
import { useRequireUser } from "@/components/SessionProvider";
import { usePrivySend } from "@/hooks/usePrivySend";
import { api } from "@/lib/api";
import { shortAddress } from "@/lib/address";
import {
  COLLATERAL_MINT,
  formatUnits,
  parseUnits,
  RPC_URL,
} from "@/lib/chain/config";

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading, setUser } = useRequireUser();
  const { logout } = usePrivy();
  const { sendBase64, walletAddress } = usePrivySend();
  const [balance, setBalance] = useState<{ sol: string; usdc: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const address = user?.walletAddress || walletAddress || "";

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
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user]);

  const requestText = useMemo(() => {
    if (!address) return "";
    return `Send me USDC on Solana devnet:\n${address}`;
  }, [address]);

  async function claimFunds() {
    setFunding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.fundWallet();
      setNotice(
        `Funded · ${res.collateral ?? "?"} collateral, ${res.sol ?? "?"} SOL`,
      );
      const b = await api.getBalance();
      setBalance({ sol: b.sol, usdc: b.usdc });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fund wallet");
    } finally {
      setFunding(false);
    }
  }

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function copyRequest() {
    if (!requestText) return;
    await navigator.clipboard.writeText(requestText);
    setNotice("Request text copied");
  }

  async function sendUsdc() {
    if (!address || !to.trim() || !amount.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const owner = new PublicKey(address);
      const dest = new PublicKey(to.trim());
      const mint = COLLATERAL_MINT;
      const units = parseUnits(amount);
      const conn = new Connection(RPC_URL, "confirmed");
      const fromAta = await getAssociatedTokenAddress(mint, owner, true);
      const toAta = await getAssociatedTokenAddress(mint, dest, true);

      const ixs = [];
      try {
        await getAccount(conn, toAta);
      } catch {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            owner,
            toAta,
            dest,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }
      ixs.push(
        createTransferInstruction(
          fromAta,
          toAta,
          owner,
          units,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );

      const { blockhash, lastValidBlockHeight } =
        await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: owner,
      }).add(...ixs);
      const raw = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const signature = await sendBase64(
        Buffer.from(raw).toString("base64"),
      );
      setNotice(`Sent · ${signature.slice(0, 8)}…`);
      setAmount("");
      setTo("");
      const b = await api.getBalance();
      setBalance({ sol: b.sol, usdc: b.usdc });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api.signOut().catch(() => {});
    await logout();
    setUser(null);
    router.replace("/onboarding");
  }

  if (loading || !user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Profile" back />
      <div className="flex-1 space-y-4 overflow-y-auto p-4 no-scrollbar">
        <Card className="space-y-3">
          <p className="font-display text-xl font-bold uppercase tracking-wide">
            {user.name}
          </p>
          <p className="text-sm text-muted">{user.phone}</p>
          <div className="flex gap-3 text-sm">
            <div>
              <p className="label-hud">USDC</p>
              <p className="font-display text-lg font-bold text-brand">
                {balance ? `$${formatUnits(balance.usdc)}` : "…"}
              </p>
            </div>
            <div>
              <p className="label-hud">SOL</p>
              <p className="font-display text-lg font-bold">
                {balance
                  ? (Number(balance.sol) / LAMPORTS_PER_SOL).toFixed(4)
                  : "…"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void copyAddress()}
            className="w-full rounded-2xl border border-border bg-surface-2 px-4 py-3 text-left font-mono text-xs text-foreground"
          >
            {copied ? "Copied" : shortAddress(address) || "No wallet"}
            <span className="mt-1 block truncate text-[10px] text-muted">
              {address}
            </span>
          </button>
          <Button variant="secondary" onClick={() => void copyRequest()}>
            Copy request
          </Button>
          <Button
            variant="secondary"
            loading={funding}
            onClick={() => void claimFunds()}
          >
            Claim devnet funds
          </Button>
        </Card>

        <Card className="space-y-3">
          <p className="font-display text-base font-bold uppercase tracking-wide">
            Send USDC
          </p>
          <TextField
            label="To address"
            name="to"
            placeholder="Solana address"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <TextField
            label="Amount"
            name="amount"
            inputMode="decimal"
            placeholder="1.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {error && <p className="text-sm text-no">{error}</p>}
          {notice && <p className="text-sm text-brand">{notice}</p>}
          <Button
            loading={busy}
            disabled={!to.trim() || !amount.trim()}
            onClick={() => void sendUsdc()}
          >
            Send with Privy
          </Button>
        </Card>

        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
