"use client";

/**
 * Onboarding — the whole account is created from a selfie + phone number.
 * Behind the scenes this triggers World Selfie Check (verification) and
 * Privy (wallet), but the user just takes a photo and types their number.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PhotoCapture } from "@/components/PhotoCapture";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";

type Step = "selfie" | "details";

export default function OnboardingPage() {
  const router = useRouter();
  const { user, loading, setUser } = useSession();
  const [step, setStep] = useState<Step>("selfie");
  const [selfie, setSelfie] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in? Skip straight to the app.
  useEffect(() => {
    if (!loading && user) router.replace("/groups");
  }, [loading, user, router]);

  async function submit() {
    if (!selfie || !name.trim() || !phone.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { user } = await api.signUp({
        name,
        phone,
        selfieDataUrl: selfie,
      });
      setUser(user);
      router.replace("/groups");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col px-6 py-8">
      <div className="mb-8 text-center">
        <div className="mb-2 text-4xl">🎲</div>
        <h1 className="text-2xl font-bold">Welcome to Groupbet</h1>
        <p className="mt-1 text-sm text-muted">
          Private prediction markets with your friends.
        </p>
      </div>

      {step === "selfie" ? (
        <div className="flex flex-1 flex-col">
          <p className="mb-4 text-center text-sm text-muted">
            Take a selfie to create your account. We use it to verify
            you&apos;re a real person — no passwords, no email.
          </p>
          <PhotoCapture
            facingMode="user"
            captureLabel="Take selfie"
            onCapture={setSelfie}
          />
          <div className="mt-auto pt-6">
            <Button disabled={!selfie} onClick={() => setStep("details")}>
              Continue
            </Button>
          </div>
        </div>
      ) : (
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
            hint="We'll text you when there's a new market to bet on."
            onChange={(e) => setPhone(e.target.value)}
          />
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto space-y-2 pt-6">
            <Button
              loading={submitting}
              disabled={!name.trim() || !phone.trim()}
              onClick={submit}
            >
              Create account
            </Button>
            <Button variant="ghost" onClick={() => setStep("selfie")}>
              Back to selfie
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
