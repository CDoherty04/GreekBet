import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Privy + Solana kit pull packages that expect webpack externals under Yarn;
  // Turbopack is fine without this, but keep the aliases harmless.
  serverExternalPackages: ["@privy-io/node"],
};

export default nextConfig;
