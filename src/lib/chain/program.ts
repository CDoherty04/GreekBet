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
 * Sign and send, retrying in a way that cannot double-apply.
 *
 * Devnet drops transactions and expires blockhashes routinely, and the naive
 * fix — rebuild and resend on timeout — can apply a trade twice. The contracts'
 * own devnet suite hit exactly that.
 *
 * The safe shape is to sign **once** and resend the *same bytes*. A Solana
 * transaction is uniquely identified by its signature, which covers its
 * blockhash, so resending an identical signed transaction is idempotent: the
 * cluster either has it or does not, and a duplicate is discarded rather than
 * executed again. Only a genuinely expired blockhash forces a rebuild, and by
 * then the original provably cannot land.
 */
export async function sendAndConfirm(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
  attempts = 3,
): Promise<string> {
  const conn = connection();
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash(COMMITMENT);

  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer }).add(
    ...instructions,
  );
  tx.sign(...signers);

  const raw = tx.serialize();
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // Identical bytes every time, so this is a resend, not a new transaction.
      const sig = await conn.sendRawTransaction(raw, {
        skipPreflight: attempt > 0, // preflight once; it re-fails on a resend
        preflightCommitment: COMMITMENT,
      });
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        COMMITMENT,
      );
      return sig;
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message ?? "";
      // A revert is deterministic — resending cannot help, and the program's
      // error is what the user needs to see.
      if (msg.includes("custom program error") || msg.includes("Error Code:")) {
        throw lastErr;
      }
      if (msg.includes("block height exceeded") || attempt === attempts - 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }

  throw lastErr ?? new Error("transaction failed");
}
