/**
 * Anchor `Program` construction and transaction submission. **Server-only.**
 *
 * The IDL is **bundled** (`src/lib/chain/greekbet.json`), never fetched. The
 * on-chain copy is incomplete: Anchor 1.2's deploy uploads the IDL to a
 * program-metadata account and that upload failed partway for this program, so
 * `anchor idl fetch` returns something unparseable. Bundling also removes an
 * RPC round-trip from every request and pins decoding to a known IDL rather
 * than whatever happens to be on chain.
 *
 * Re-copy after any program change:
 *   cp contracts/target/idl/greekbet.json src/lib/chain/greekbet.json
 */

import "server-only";

import { AnchorProvider, Program, type Idl } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import idlJson from "./greekbet.json";
import { PROGRAM_ID, RPC_URL } from "./config";

export const idl = idlJson as unknown as Idl;

/**
 * `confirmed`, deliberately.
 *
 * `processed` can return state that is later rolled back, and the contract test
 * suite already had to pin `confirmed` because a read straight after a write
 * came back stale. On devnet, where latency runs 600–2,000 ms, `processed`
 * would make the UI show trades that may not have happened.
 */
export const COMMITMENT = "confirmed" as const;

let cachedConnection: Connection | null = null;

export function connection(): Connection {
  cachedConnection ??= new Connection(RPC_URL, COMMITMENT);
  return cachedConnection;
}

/**
 * Anchor's `Wallet` interface over a raw `Keypair`.
 *
 * Anchor does export a `Wallet` class, but only as a CommonJS lazy assignment
 * (`exports.Wallet = require("./nodewallet.js").default`) that its ESM build
 * cannot resolve statically — importing it breaks the Next build outright.
 * Deep-importing `@anchor-lang/core/dist/cjs/nodewallet` would work and would
 * also bind us to an internal path.
 *
 * The interface is three members, so implementing it is both smaller and more
 * durable than either workaround.
 */
class KeypairWallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.payer]);
    } else {
      tx.partialSign(this.payer);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }
}

/** A Program bound to `signer`, for building instructions and simulating. */
export function programFor(signer: Keypair): Program {
  const provider = new AnchorProvider(connection(), new KeypairWallet(signer), {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });
  return new Program(idl, provider);
}

/** Read-only Program, for account fetches that need no signer. */
export function readOnlyProgram(): Program {
  return programFor(Keypair.generate());
}

export { PROGRAM_ID };

/**
 * Build an unsigned legacy transaction for the fee payer to sign (Privy).
 *
 * Returns base64 bytes suitable for `useSignAndSendTransaction`.
 */
export async function buildUnsignedTransaction(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
): Promise<string> {
  const conn = connection();
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash(COMMITMENT);
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer }).add(
    ...instructions,
  );
  const raw = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return Buffer.from(raw).toString("base64");
}

/**
 * Sign and send for server-held keys (resolver / fee payer), not user wallets.
 *
 * Devnet drops transactions and expires blockhashes routinely. Strategy:
 *
 * 1. **Resend identical bytes** while the blockhash is still valid.
 * 2. On expiry, **ask the cluster if the signature landed** before rebuilding
 *    (`confirmTransaction` expiry does not mean the tx failed — see
 *    `contracts/docs/DEVNET.md` §5.4).
 * 3. **Rebuild with a fresh blockhash** only when the cluster has never seen
 *    the signature. Callers are close/resolve (idempotent on chain).
 */
export async function sendAndConfirm(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
  rebuilds = 4,
): Promise<string> {
  const conn = connection();
  let lastErr: Error | undefined;

  // Fail fast — a zero-SOL fee payer otherwise burns rebuilds waiting for
  // blockhash expiry after we skip preflight on a retry.
  const balance = await conn.getBalance(feePayer, COMMITMENT);
  if (balance < 5_000) {
    throw new Error(
      `Attempt to debit an account but found no record of a prior credit (fee payer ${feePayer.toBase58()} has ${balance} lamports)`,
    );
  }

  for (let rebuild = 0; rebuild < rebuilds; rebuild++) {
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash(COMMITMENT);

    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer }).add(
      ...instructions,
    );
    tx.sign(...signers);
    const raw = tx.serialize();
    // Signature is determined at sign time — reuse for status checks.
    const signature = bs58.encode(tx.signature!);

    // A few identical-byte resends before giving up on this blockhash.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await conn.sendRawTransaction(raw, {
          // Always preflight the first send of a rebuild so empty fee-payer /
          // program errors surface immediately instead of timing out.
          skipPreflight: attempt > 0,
          preflightCommitment: COMMITMENT,
          maxRetries: 5,
        });
        const confirmed = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          COMMITMENT,
        );
        if (confirmed.value.err) {
          throw new Error(
            `Transaction ${signature} failed on chain: ${JSON.stringify(confirmed.value.err)}`,
          );
        }
        return signature;
      } catch (err) {
        lastErr = err as Error;
        const msg = lastErr.message ?? "";

        // Did it land anyway? Expiry often lies on public RPC.
        try {
          const st = await conn.getSignatureStatus(signature, {
            searchTransactionHistory: true,
          });
          if (st?.value) {
            if (st.value.err) {
              throw new Error(
                `Transaction ${signature} failed on chain: ${JSON.stringify(st.value.err)}`,
              );
            }
            return signature;
          }
        } catch (statusErr) {
          const statusMsg =
            statusErr instanceof Error ? statusErr.message : String(statusErr);
          if (statusMsg.includes("failed on chain")) throw statusErr;
        }

        if (
          msg.includes("custom program error") ||
          msg.includes("Error Code:") ||
          msg.includes("failed on chain") ||
          msg.includes("Attempt to debit an account") ||
          msg.includes("insufficient funds") ||
          msg.includes("insufficient lamports")
        ) {
          throw lastErr;
        }
        // Blockhash dead and signature unseen — outer loop rebuilds.
        if (
          msg.includes("block height exceeded") ||
          lastErr.name === "TransactionExpiredBlockheightExceededError"
        ) {
          break;
        }
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }

  throw lastErr ?? new Error("transaction failed");
}
