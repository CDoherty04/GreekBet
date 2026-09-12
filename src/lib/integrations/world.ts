/**
 * World ID — Selfie Check (Beta) via IDKit.
 *
 * Selfie Check is a liveness / abuse-prevention credential from World App.
 * We verify proofs server-side and store nullifiers. AI only judges event
 * photo *content* — never identity.
 *
 * Without Developer Portal credentials the app uses a labeled stub so local
 * demos still work. Set keys + `WORLD_SELFIE_CHECK_STUB=false` for live mode.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { IDKitResult } from "@worldcoin/idkit-core";

export type WorldAction = "signup" | "resolve";

export const WORLD_ACTIONS = {
  signup: "signup",
  resolve: "resolve",
} as const satisfies Record<WorldAction, string>;

/** Per-market resolve action so one person can Selfie-Check more than once. */
export function worldActionId(
  action: WorldAction,
  marketId?: string,
): string {
  if (action === "resolve") {
    if (!marketId) throw new Error("resolve action requires marketId");
    return `resolve-${marketId}`;
  }
  return WORLD_ACTIONS.signup;
}

export interface WorldPublicConfig {
  configured: boolean;
  stub: boolean;
  appId: `app_${string}` | null;
  rpId: string | null;
  environment: "production" | "staging" | "sandbox";
}

export interface RpSignaturePayload {
  sig: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  rp_id: string;
  action: string;
  stub: boolean;
}

export interface VerifiedSelfieProof {
  verified: boolean;
  stub: boolean;
  nullifier: string;
  identifier: string;
  action: string;
}

/** Client/server stub payload when Developer Portal keys are absent. */
export interface StubIdKitResult {
  stub: true;
  protocol_version: "3.0";
  nonce: string;
  action: string;
  environment: string;
  responses: Array<{
    identifier: "selfie";
    nullifier: string;
    proof: string;
    merkle_root: string;
    signal_hash?: string;
  }>;
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function worldKeysPresent(): boolean {
  return Boolean(
    env("NEXT_PUBLIC_WORLD_APP_ID") &&
      env("NEXT_PUBLIC_WORLD_RP_ID") &&
      env("WORLD_RP_SIGNING_KEY"),
  );
}

/** True when we mint local proofs instead of calling Developer Portal. */
export function isWorldStubMode(): boolean {
  if (env("WORLD_SELFIE_CHECK_STUB") === "true") return true;
  if (env("WORLD_SELFIE_CHECK_STUB") === "false") return false;
  return !worldKeysPresent();
}

export function getWorldPublicConfig(): WorldPublicConfig {
  const appId = env("NEXT_PUBLIC_WORLD_APP_ID") as `app_${string}` | undefined;
  const rpId = env("NEXT_PUBLIC_WORLD_RP_ID");
  const rawEnv = env("NEXT_PUBLIC_WORLD_ENVIRONMENT") ?? "sandbox";
  const environment =
    rawEnv === "production" || rawEnv === "staging" || rawEnv === "sandbox"
      ? rawEnv
      : "sandbox";

  return {
    configured: worldKeysPresent(),
    stub: isWorldStubMode(),
    appId: appId ?? null,
    rpId: rpId ?? null,
    environment,
  };
}

export function createRpSignature(action: string): RpSignaturePayload {
  if (isWorldStubMode()) {
    const now = Math.floor(Date.now() / 1000);
    return {
      sig: "0xstub",
      nonce: `0x${createHash("sha256").update(`${action}:${now}`).digest("hex")}`,
      created_at: now,
      expires_at: now + 300,
      rp_id: env("NEXT_PUBLIC_WORLD_RP_ID") ?? "rp_stub",
      action,
      stub: true,
    };
  }

  const signingKeyHex = env("WORLD_RP_SIGNING_KEY");
  const rpId = env("NEXT_PUBLIC_WORLD_RP_ID");
  if (!signingKeyHex || !rpId) {
    throw new Error(
      "World Selfie Check is not configured (WORLD_RP_SIGNING_KEY / NEXT_PUBLIC_WORLD_RP_ID)",
    );
  }

  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex,
    action,
  });

  return {
    sig,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    rp_id: rpId,
    action,
    stub: false,
  };
}

const NULLIFIER_FILE = path.join(
  process.cwd(),
  ".data",
  "world-nullifiers.json",
);

type NullifierRecord = { action: string; nullifier: string; at: number };

function loadNullifiers(): Map<string, NullifierRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(NULLIFIER_FILE, "utf8")) as
      | NullifierRecord[]
      | { entries?: NullifierRecord[] };
    const list = Array.isArray(raw) ? raw : (raw.entries ?? []);
    return new Map(
      list.map((e) => [`${e.action}:${e.nullifier.toLowerCase()}`, e]),
    );
  } catch {
    return new Map();
  }
}

function saveNullifiers(map: Map<string, NullifierRecord>): void {
  try {
    fs.mkdirSync(path.dirname(NULLIFIER_FILE), { recursive: true });
    fs.writeFileSync(
      NULLIFIER_FILE,
      JSON.stringify([...map.values()], null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("world nullifier persist failed", err);
  }
}

const globalForNullifiers = globalThis as unknown as {
  __worldNullifiers?: Map<string, NullifierRecord>;
};

function nullifierStore(): Map<string, NullifierRecord> {
  if (!globalForNullifiers.__worldNullifiers) {
    globalForNullifiers.__worldNullifiers = loadNullifiers();
  }
  return globalForNullifiers.__worldNullifiers;
}

export function claimNullifier(action: string, nullifier: string): boolean {
  const store = nullifierStore();
  const key = `${action}:${nullifier.toLowerCase()}`;
  if (store.has(key)) return false;
  store.set(key, { action, nullifier, at: Date.now() });
  saveNullifiers(store);
  return true;
}

function extractNullifier(result: IDKitResult): {
  nullifier: string;
  identifier: string;
  signalHash?: string;
} {
  const item = result.responses?.[0];
  if (!item) throw new Error("IDKit result has no responses");

  if ("nullifier" in item && typeof item.nullifier === "string") {
    return {
      nullifier: item.nullifier,
      identifier: item.identifier,
      signalHash: item.signal_hash,
    };
  }

  throw new Error("Unsupported IDKit result shape for Selfie Check");
}

function assertSelfieIdentifier(identifier: string): void {
  if (identifier !== "selfie" && identifier !== "face") {
    throw new Error(
      `Expected Selfie Check credential, got identifier "${identifier}"`,
    );
  }
}

function assertSignal(
  expectedSignal: string | undefined,
  signalHash: string | undefined,
): void {
  if (!expectedSignal) return;
  if (!signalHash) throw new Error("Proof is missing signal_hash");
  const expected = hashSignal(expectedSignal);
  if (expected.toLowerCase() !== signalHash.toLowerCase()) {
    throw new Error("Proof signal does not match this request");
  }
}

export function buildStubIdKitResult(input: {
  action: string;
  signal?: string;
}): StubIdKitResult {
  const digest = createHash("sha256")
    .update(`${input.action}:${input.signal ?? "anon"}:${Date.now()}`)
    .digest("hex");
  return {
    stub: true,
    protocol_version: "3.0",
    nonce: `0x${digest.slice(0, 32)}`,
    action: input.action,
    environment: "stub",
    responses: [
      {
        identifier: "selfie",
        nullifier: `0x${digest}`,
        proof: "0xstub",
        merkle_root: "0xstub",
        signal_hash: input.signal ? hashSignal(input.signal) : undefined,
      },
    ],
  };
}

/**
 * Verify an IDKit Selfie Check proof against Developer Portal (or stub).
 * Forwards the IDKit payload unchanged — do not remap fields.
 */
export async function verifySelfieProof(input: {
  action: string;
  signal?: string;
  idkitResult: IDKitResult | StubIdKitResult;
}): Promise<VerifiedSelfieProof> {
  const { action, signal, idkitResult } = input;

  if (
    isWorldStubMode() ||
    ("stub" in idkitResult && idkitResult.stub === true)
  ) {
    const stub =
      "stub" in idkitResult && idkitResult.stub
        ? (idkitResult as StubIdKitResult)
        : buildStubIdKitResult({ action, signal });
    const nullifier = stub.responses[0]?.nullifier;
    if (!nullifier) throw new Error("Stub proof missing nullifier");
    assertSignal(signal, stub.responses[0]?.signal_hash);
    if (!claimNullifier(action, nullifier)) {
      throw new Error("This Selfie Check proof was already used");
    }
    return {
      verified: true,
      stub: true,
      nullifier,
      identifier: "selfie",
      action,
    };
  }

  const rpId = env("NEXT_PUBLIC_WORLD_RP_ID");
  if (!rpId) throw new Error("NEXT_PUBLIC_WORLD_RP_ID is not set");

  const response = await fetch(
    `https://developer.world.org/api/v4/verify/${rpId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResult),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `World verification failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const { nullifier, identifier, signalHash } = extractNullifier(
    idkitResult as IDKitResult,
  );
  assertSelfieIdentifier(identifier);
  assertSignal(signal, signalHash);

  const resultAction =
    "action" in idkitResult && typeof idkitResult.action === "string"
      ? idkitResult.action
      : action;
  if (resultAction && resultAction !== action) {
    throw new Error(`Proof action mismatch (expected ${action})`);
  }

  if (!claimNullifier(action, nullifier)) {
    throw new Error("This Selfie Check proof was already used");
  }

  return {
    verified: true,
    stub: false,
    nullifier,
    identifier,
    action,
  };
}

const globalForPending = globalThis as unknown as {
  __worldPendingProofs?: Map<
    string,
    { nullifier: string; at: number; userId: string }
  >;
};

function pendingStore(): Map<
  string,
  { nullifier: string; at: number; userId: string }
> {
  if (!globalForPending.__worldPendingProofs) {
    globalForPending.__worldPendingProofs = new Map();
  }
  return globalForPending.__worldPendingProofs;
}

function pendingKey(userId: string, action: string, signal: string): string {
  return `${userId}:${action}:${signal}`;
}

/** Remember a verified proof so a later route can consume it once. */
export function rememberVerifiedProof(input: {
  userId: string;
  action: string;
  signal: string;
  nullifier: string;
}): void {
  pendingStore().set(pendingKey(input.userId, input.action, input.signal), {
    nullifier: input.nullifier,
    at: Date.now(),
    userId: input.userId,
  });
}

/**
 * Consume a previously verified Selfie Check (max 15 min). Returns false if
 * missing, expired, or nullifier mismatch.
 */
export function consumeVerifiedProof(input: {
  userId: string;
  action: string;
  signal: string;
  nullifier: string;
}): boolean {
  const store = pendingStore();
  const key = pendingKey(input.userId, input.action, input.signal);
  const entry = store.get(key);
  if (!entry) return false;
  store.delete(key);
  if (Date.now() - entry.at > 15 * 60 * 1000) return false;
  return entry.nullifier.toLowerCase() === input.nullifier.toLowerCase();
}
