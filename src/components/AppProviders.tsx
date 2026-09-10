"use client";

/**
 * Privy + session providers.
 *
 * Privy owns SMS login and the Solana embedded wallet. Our SessionProvider
 * still loads the app user profile (name, selfie, World id) from `/api/session`.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { SessionProvider } from "@/components/SessionProvider";

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const rpcHttp =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const rpcWs = rpcHttp.replace(/^https:/, "wss:");

export function AppProviders({ children }: { children: React.ReactNode }) {
  if (!appId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl font-extrabold uppercase">
          Privy not configured
        </p>
        <p className="max-w-sm text-sm text-muted">
          Set <code className="text-brand">NEXT_PUBLIC_PRIVY_APP_ID</code> and{" "}
          <code className="text-brand">PRIVY_APP_SECRET</code> in{" "}
          <code>.env.local</code>, enable SMS + Solana in the Privy dashboard,
          then restart the dev server.
        </p>
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["sms"],
        appearance: {
          walletChainType: "solana-only",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "all-users",
          },
          // Headless signing — the connect/confirm modals often surface
          // "Failed to connect to wallet" for already-provisioned embedded wallets.
          showWalletUIs: false,
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc(rpcHttp),
              rpcSubscriptions: createSolanaRpcSubscriptions(rpcWs),
            },
          },
        },
        intl: {
          defaultCountry: "US",
        },
      }}
    >
      <SessionProvider>{children}</SessionProvider>
    </PrivyProvider>
  );
}
