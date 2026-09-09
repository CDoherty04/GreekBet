"use client";

/**
 * Onboarding — name + phone, confirm via Telegram Gateway (or stub),
 * then selfie. Returning users skip the selfie after the code.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PhotoCapture } from "@/components/PhotoCapture";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { phoneError } from "@/lib/phone";

type Step = "details" | "code" | "selfie" | "telegram";
type Channel = "telegram" | "stub";

export default function OnboardingPage() {
  const router = useRouter();
  const { user, loading, setUser } = useSession();
  const [step, setStep] = useState<Step>("details");
  const [selfie, setSelfie] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState<Channel>("stub");
  const [devCode, setDevCode] = useState<string | undefined>();
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const phoneIssue = phoneError(phone);

  useEffect(() => {
    if (!loading && user && step === "details") router.replace("/groups");
  }, [loading, user, router, step]);

  async function requestCode() {
    if (!name.trim() || phoneIssue) {
      setPhoneTouched(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.sendVerification(phone);
      setPhone(res.phone);
      setChannel(res.channel);
      setDevCode(res.devCode);
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
      const res = await api.checkVerification(phone, code);
      if (res.user) {
        setUser(res.user);
        router.replace("/groups");
        return;
      }
      setStep("selfie");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify code");
    } finally {
      setSubmitting(false);
    }
  }

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
      if (user.telegramChatId) {
        router.replace("/groups");
        return;
      }
      try {
        const link = await api.linkTelegram();
        if (!link.deepLink) {
          router.replace("/groups");
          return;
        }
        setDeepLink(link.deepLink);
        setStep("telegram");
      } catch {
        router.replace("/groups");
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmTelegram() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.syncTelegram();
      if (!res.matched) {
        setError("Open the bot and tap Start, then try again.");
        return;
      }
      router.replace("/groups");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link Telegram");
    } finally {
      setSubmitting(false);
    }
  }

  const channelHint =
    channel === "telegram"
      ? "Check Telegram on that number for the code."
      : "No Telegram Gateway key set — using demo mode.";

  return (
    <div className="flex flex-1 flex-col px-6 py-8">
      <div className="mb-8 text-center">
        <h1 className="font-display text-4xl font-extrabold uppercase leading-none tracking-tight">
          Welcome to Groupbet
        </h1>
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
            hint="Include country code. We’ll send a Telegram confirmation code."
            className={phoneTouched && phoneIssue ? "border-no" : ""}
            onBlur={() => setPhoneTouched(true)}
            onChange={(e) => setPhone(e.target.value)}
          />
          {phoneTouched && phoneIssue && (
            <p className="-mt-2 text-sm text-no">{phoneIssue}</p>
          )}
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto pt-6">
            <Button
              loading={submitting}
              disabled={!name.trim() || Boolean(phoneIssue)}
              onClick={() => void requestCode()}
            >
              Send code
            </Button>
            <Link
              href="/debug"
              className="mt-3 block text-center font-display text-[10px] font-bold tracking-[0.16em] uppercase text-muted hover:text-brand"
            >
              Debug
            </Link>
          </div>
        </div>
      ) : step === "code" ? (
        <div className="flex flex-1 flex-col gap-4">
          <p className="text-sm text-muted">{channelHint}</p>
          {devCode && (
            <p className="rounded-2xl border border-brand/40 bg-brand/10 px-4 py-3 font-display text-lg font-bold tracking-[0.3em] text-brand">
              {devCode}
            </p>
          )}
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
              loading={submitting}
              disabled={code.length < 4}
              onClick={() => void confirmCode()}
            >
              Confirm
            </Button>
            <Button variant="ghost" disabled={submitting} onClick={() => void requestCode()}>
              Resend code
            </Button>
            <Button variant="ghost" disabled={submitting} onClick={() => setStep("details")}>
              Back
            </Button>
          </div>
        </div>
      ) : step === "selfie" ? (
        <div className="flex flex-1 flex-col">
          <p className="mb-4 text-center text-sm text-muted">
            We use this photo to verify events relevant to you
          </p>
          <PhotoCapture
            facingMode="user"
            captureLabel="Take selfie"
            onCapture={setSelfie}
          />
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto space-y-2 pt-6">
            <Button loading={submitting} disabled={!selfie} onClick={() => void submit()}>
              Create account
            </Button>
            <Button variant="ghost" onClick={() => setStep("code")}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <p className="text-sm text-muted">
            Open Telegram and tap Start so we can ping you when someone posts
            an event
          </p>
          {error && <p className="text-sm text-no">{error}</p>}
          <div className="mt-auto space-y-2 pt-6">
            <Button
              type="button"
              onClick={() =>
                deepLink && window.open(deepLink, "_blank", "noopener,noreferrer")
              }
            >
              Open Telegram
            </Button>
            <Button
              variant="secondary"
              loading={submitting}
              onClick={() => void confirmTelegram()}
            >
              I&apos;ve opened the bot
            </Button>
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => router.replace("/groups")}
            >
              Skip for now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
