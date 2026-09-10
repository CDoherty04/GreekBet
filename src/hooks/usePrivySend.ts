"use client";

/**
 * Sign and send a base64 Solana transaction with the user's Privy wallet.
 *
 * Prefers the wallet that matches the app session address so we never sign
 * with a different Privy HD account than the one we built the tx for.
 */

import { useCallback } from "react";
import {
  useSignAndSendTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import bs58 from "bs58";
import { useSession } from "@/components/SessionProvider";

export function usePrivySend() {
  const { user } = useSession();
  const { wallets, ready } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const wallet =
    (user?.walletAddress
      ? wallets.find((w) => w.address === user.walletAddress)
      : undefined) ??
    wallets.find((w) => w.standardWallet?.name === "Privy") ??
    wallets[0];

  const sendBase64 = useCallback(
    async (transactionBase64: string): Promise<string> => {
      if (!ready) throw new Error("Privy wallets still loading — try again");
      if (!wallet) throw new Error("No Privy Solana wallet connected");
      if (
        user?.walletAddress &&
        wallet.address !== user.walletAddress
      ) {
        throw new Error(
          `Wallet mismatch: session is ${user.walletAddress.slice(0, 4)}… but Privy would sign with ${wallet.address.slice(0, 4)}… — refresh or re-link.`,
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
    [signAndSendTransaction, wallet, user?.walletAddress, ready],
  );

  return {
    ready,
    walletAddress: wallet?.address ?? null,
    sendBase64,
  };
}
