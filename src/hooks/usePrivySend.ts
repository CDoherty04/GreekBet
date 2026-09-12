"use client";

/**
 * Sign and send a base64 Solana transaction with the user's Privy wallet.
 *
 * Prefers the wallet that matches the app session address so we never sign
 * with a different Privy HD account than the one we built the tx for.
 *
 * Privy's `ready` flag often lags a second or two after login — we wait for
 * it instead of failing immediately with "still loading".
 */

import { useCallback, useRef } from "react";
import {
  useSignAndSendTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import bs58 from "bs58";
import { useSession } from "@/components/SessionProvider";

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;

export function usePrivySend() {
  const { user } = useSession();
  const { wallets, ready } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const readyRef = useRef(ready);
  const walletsRef = useRef(wallets);
  const userWalletRef = useRef(user?.walletAddress);
  readyRef.current = ready;
  walletsRef.current = wallets;
  userWalletRef.current = user?.walletAddress;

  const pickWallet = useCallback(() => {
    const list = walletsRef.current;
    const sessionAddr = userWalletRef.current;
    return (
      (sessionAddr
        ? list.find((w) => w.address === sessionAddr)
        : undefined) ??
      list.find((w) => w.standardWallet?.name === "Privy") ??
      list[0]
    );
  }, []);

  const waitForWallet = useCallback(async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (readyRef.current) {
        const wallet = pickWallet();
        if (wallet) return wallet;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (!readyRef.current) {
      throw new Error(
        "Privy wallets still loading — wait a moment and try again (on Vercel, check this domain is allowed in the Privy dashboard)",
      );
    }
    throw new Error("No Privy Solana wallet connected");
  }, [pickWallet]);

  const sendBase64 = useCallback(
    async (transactionBase64: string): Promise<string> => {
      const wallet = await waitForWallet();
      const sessionAddr = userWalletRef.current;
      if (sessionAddr && wallet.address !== sessionAddr) {
        throw new Error(
          `Wallet mismatch: session is ${sessionAddr.slice(0, 4)}… but Privy would sign with ${wallet.address.slice(0, 4)}… — refresh or re-link.`,
        );
      }

      const transaction = Uint8Array.from(
        atob(transactionBase64),
        (c) => c.charCodeAt(0),
      );

      try {
        const { signature } = await signAndSendTransaction({
          transaction,
          wallet,
          chain: "solana:devnet",
          options: {
            // Devnet RPC simulation is flaky; the program still enforces
            // correctness on chain.
            skipSimulation: true,
            // Headless — avoids Privy's "Failed to connect to wallet" modal
            // when the embedded wallet is already available.
            uiOptions: { showWalletUIs: false },
          },
        });
        return bs58.encode(signature);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err);
        throw new Error(msg || "Privy could not send the transaction");
      }
    },
    [signAndSendTransaction, waitForWallet],
  );

  return {
    ready,
    walletAddress: pickWallet()?.address ?? null,
    sendBase64,
  };
}
