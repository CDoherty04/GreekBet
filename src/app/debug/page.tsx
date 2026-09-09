"use client";

/**
 * Debug menu — typed bot DMs first, then Gateway OTP.
 */

import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/TextField";
import { useSession } from "@/components/SessionProvider";
import { api } from "@/lib/api";

interface Status {
  telegramBot: boolean;
  telegramGateway: boolean;
  linkedChatId: boolean;
}

export default function DebugPage() {
  const { user, setUser } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState("Hello from Groupbet");
  const [phone, setPhone] = useState("");
  const [log, setLog] = useState<string | null>(null);
  const [logOk, setLogOk] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const phoneValue = phone || user?.phone || "";

  useEffect(() => {
    void api.debugStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function run(id: string, fn: () => Promise<string>) {
    setBusy(id);
    setLog(null);
    try {
      setLog(await fn());
      setLogOk(true);
      const next = await api.debugStatus().catch(() => null);
      if (next) setStatus(next);
    } catch (e) {
      setLogOk(false);
      setLog(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Debug" back />
      <div className="flex-1 space-y-4 overflow-y-auto p-4 no-scrollbar">
        <Card className="space-y-1 text-xs text-muted">
          <p className="label-hud mb-2">Providers</p>
          <Flag on={status?.telegramBot} label="Telegram bot (notifications)" />
          <Flag on={status?.telegramGateway} label="Telegram Gateway OTP" />
          <Flag on={status?.linkedChatId} label="This session linked a chat" />
        </Card>

        <TextField
          label="Phone"
          name="debug-phone"
          type="tel"
          placeholder="+1 555 123 4567"
          value={phoneValue}
          hint="Sends to this number’s Telegram. They must have tapped Start once."
          onChange={(e) => setPhone(e.target.value)}
        />

        <div>
          <p className="label-hud mb-2">Message</p>
          <textarea
            name="tg-message"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full rounded-2xl border border-border bg-surface-2 px-4 py-3.5 text-base text-foreground outline-none placeholder:text-muted/60 focus:border-brand"
            placeholder="Type a Telegram message"
          />
        </div>

        <Button
          loading={busy === "tg"}
          disabled={!message.trim() || !phoneValue.trim()}
          onClick={() =>
            void run("tg", async () => {
              const res = await api.sendTelegram(message, phoneValue);
              return `Sent to ${res.phone}`;
            })
          }
        >
          Send Telegram message
        </Button>
        <Button
          variant="secondary"
          loading={busy === "otp"}
          disabled={!phoneValue.trim()}
          onClick={() =>
            void run("otp", async () => {
              const res = await api.sendVerification(phoneValue);
              const extra = res.devCode ? ` Demo code: ${res.devCode}` : "";
              return `Code via ${res.channel} to ${res.phone}.${extra}`;
            })
          }
        >
          Send verification code
        </Button>

        <Button
          variant="secondary"
          loading={busy === "sync"}
          disabled={!user}
          onClick={() =>
            void run("sync", async () => {
              const link = await api.linkTelegram();
              if (link.deepLink) {
                window.open(link.deepLink, "_blank", "noopener,noreferrer");
              }
              const res = await api.syncTelegram();
              if (res.telegramChatId && user) {
                setUser({ ...user, telegramChatId: res.telegramChatId });
              }
              return res.matched
                ? `Linked chat ${res.telegramChatId}`
                : `Opened bot. Tap Start, then press this again.`;
            })
          }
        >
          Link Telegram bot
        </Button>

        <Button
          variant="ghost"
          loading={busy === "out"}
          disabled={!user}
          onClick={() =>
            void run("out", async () => {
              await api.signOut();
              setUser(null);
              return "Signed out";
            })
          }
        >
          Sign out
        </Button>

        {log && (
          <p className={`text-sm ${logOk ? "text-yes" : "text-no"}`}>{log}</p>
        )}
      </div>
    </div>
  );
}

function Flag({ on, label }: { on?: boolean; label: string }) {
  return (
    <p>
      <span className={on ? "text-yes" : "text-muted"}>{on ? "ON" : "OFF"}</span>
      {" · "}
      {label}
    </p>
  );
}
