"use client";

/**
 * Onboarding — name + phone via Privy SMS, then World Selfie Check.
 *
 * Skip to /groups only when an *app* profile exists (not merely Privy auth).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLoginWithSms, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useWallets } from "@privy-io/react-auth/solana";
import {
  WorldSelfieCheck,
  type WorldSelfieVerified,
} from "@/components/WorldSelfieCheck";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { normalizePhone, phoneError } from "@/lib/phone";

type Step = "details" | "code" | "world";

function pickSolanaAddress(
  wallets: { address: string; standardWallet?: { name?: string } }[],
): string | null {
  if (!wallets.length) return null;
  const embedded = wallets.find((w) =>
    (w.standardWallet?.name ?? "").toLowerCase().includes("privy"),
  );
  return embedded?.address ?? wallets[0]?.address ?? null;
}

function alreadyHasWalletError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already has an embedded wallet/i.test(msg);
}

export default function OnboardingPage() {
  const router = useRouter();
  const { user, loading, setUser, refresh } = useSession();
  const { authenticated, ready, user: privyUser } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();

  const [step, setStep] = useState<Step>("details");
  const [worldProof, setWorldProof] = useState<WorldSelfieVerified | null>(
    null,
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const walletAttempted = useRef(false);
  const phonePrefillDone = useRef(false);

  const { sendCode, loginWithCode, state } = useLoginWithSms({
    onComplete: () => {
      void refresh();
    },
    onError: (err) => {
      setError(typeof err === "string" ? err : "Login failed");
    },
  });

  const phoneIssue = phoneError(phone);
  const solanaAddress = useMemo(() => pickSolanaAddress(wallets), [wallets]);
  const hasDetails = Boolean(name.trim() && !phoneIssue);
  const worldSignal = privyUser?.id ?? "";

  const smsBusy =
    submitting ||
    state.status === "sending-code" ||
    state.status === "submitting-code";

  useEffect(() => {
    if (!loading && user) router.replace("/groups");
  }, [loading, user, router]);

  useEffect(() => {
    if (!authenticated || !privyUser || phonePrefillDone.current) return;
    const fromPrivy =
      privyUser.phone?.number ||
      privyUser.linkedAccounts?.find((a) => a.type === "phone")?.number;
    if (fromPrivy && !phone) {
      setPhone(fromPrivy);
      phonePrefillDone.current = true;
    }
  }, [authenticated, privyUser, phone]);

  useEffect(() => {
    if (!ready || !authenticated || user || loading) return;
    if (!hasDetails) {
      if (step !== "details") setStep("details");
      return;
    }
    if (step === "details" || step === "code") setStep("world");
  }, [ready, authenticated, user, loading, step, hasDetails]);

  useEffect(() => {
    if (!authenticated || !walletsReady || solanaAddress || walletAttempted.current) {
      return;
    }
    walletAttempted.current = true;
    setCreatingWallet(true);
    void createWallet()
      .catch((e) => {
        if (!alreadyHasWalletError(e)) {
          console.error("createWallet", e);
          walletAttempted.current = false;
        }
      })
      .finally(() => setCreatingWallet(false));
  }, [authenticated, walletsReady, solanaAddress, createWallet]);

  async function ensureWallet(): Promise<string> {
    const existing = pickSolanaAddress(wallets);
    if (existing) return existing;
    setCreatingWallet(true);
    try {
      const created = await createWallet();
      const address =
        (created as { wallet?: { address?: string } }).wallet?.address ??
        (created as { address?: string }).address ??
        pickSolanaAddress(wallets);
      if (!address) {
        throw new Error(
          "Privy wallet not ready — check Solana embedded wallets are enabled in the Privy dashboard",
        );
      }
      return address;
    } catch (e) {
      if (alreadyHasWalletError(e)) {
        const again = pickSolanaAddress(wallets);
        if (again) return again;
      }
      throw e;
    } finally {
      setCreatingWallet(false);
    }
  }

  async function requestCode() {
    if (!name.trim() || phoneIssue) {
      setPhoneTouched(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const normalized = normalizePhone(phone);
      setPhone(normalized);
      await sendCode({ phoneNumber: normalized });
      setCode("");
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send code");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmCode() {
    setSubmitting(true);
    setError(null);
    try {
      await loginWithCode({ code });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify code");
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    if (!worldProof) {
      setError("Complete World Selfie Check first");
      return;
    }
    if (!name.trim() || phoneIssue) {
      setError("Enter your name and phone to finish setup");
      setStep("details");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const walletAddress = await ensureWallet();
      const { user: created } = await api.completeProfile({
        name,
        phone: normalizePhone(phone),
        walletAddress,
        worldId: worldProof.worldId,
      });
      setUser(created);
      router.replace("/groups");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col px-6 py-8">
      <div className="mb-8 text-center">
        <h1 className="font-display text-4xl font-extrabold uppercase leading-none tracking-tight">
          Welcome to Groupbet
        </h1>
        {authenticated && !user && (
          <p className="mt-3 text-sm text-muted">
            You’re signed in — finish your profile to continue.
          </p>
        )}
      </div>

      {step === "details" ? (
        <div className="flex flex-1 flex-col gap-4">
          <TextField
            label="Your name"
            name="name"
            placeholder="Alex"
            value={name}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="Phone number"
            name="phone"
            type="tel"
            placeholder="+1 555 123 4567"
            value={phone}
            autoComplete="tel"
            hint={
              authenticated
                ? "Confirm the number on your Privy account."
                : "We’ll text you a code via Privy. Include country code."
            }
            className={phoneTouched && phoneIssue ? "border-no" : ""}
            onBlur={() => setPhoneTouched(true)}
            onChange={(e) => setPhone(e.target.value)}
          />
          {phoneTouched && phoneIssue && (
            <p className="-mt-2 text-sm text-no">{phoneIssue}</p>
          )}
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto pt-6">
            {authenticated ? (
              <Button
                disabled={!hasDetails}
                onClick={() => setStep("world")}
              >
                Continue
              </Button>
            ) : (
              <Button
                loading={smsBusy}
                disabled={!name.trim() || Boolean(phoneIssue)}
                onClick={() => void requestCode()}
              >
                Send code
              </Button>
            )}
          </div>
        </div>
      ) : step === "code" ? (
        <div className="flex flex-1 flex-col gap-4">
          <p className="text-sm text-muted">
            Enter the SMS code Privy sent to {normalizePhone(phone)}.
          </p>
          <TextField
            label="Confirmation code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto space-y-2 pt-6">
            <Button
              loading={smsBusy}
              disabled={code.length < 4}
              onClick={() => void confirmCode()}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              disabled={smsBusy}
              onClick={() => void requestCode()}
            >
              Resend code
            </Button>
            <Button
              variant="ghost"
              disabled={smsBusy}
              onClick={() => setStep("details")}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <p className="mb-2 text-center text-sm text-muted">
            Prove you’re a live person with World Selfie Check. This gates
            accounts against bots — we don’t store your selfie.
          </p>
          {!solanaAddress && (
            <p className="text-center text-xs text-muted">
              {creatingWallet || !walletsReady
                ? "Preparing your Solana wallet…"
                : "Waiting for Privy wallet…"}
            </p>
          )}
          {worldSignal ? (
            <WorldSelfieCheck
              action="signup"
              signal={worldSignal}
              disabled={creatingWallet}
              onVerified={setWorldProof}
              onError={setError}
            />
          ) : (
            <p className="text-sm text-muted">Waiting for Privy session…</p>
          )}
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto space-y-2 pt-6">
            <Button
              loading={submitting}
              disabled={!worldProof || creatingWallet}
              onClick={() => void submit()}
            >
              Create account
            </Button>
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => setStep("details")}
            >
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
