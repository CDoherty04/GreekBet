/**
 * /api/telegram/send — send a typed message to the Telegram account
 * for a phone number (looked up from a prior bot Start).
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { phoneError } from "@/lib/phone";
import { sendTelegramMessage, telegramBotConfigured } from "@/lib/integrations/telegram";
import { absorbTelegramStarts, chatIdForPhone } from "@/lib/telegram-link";

interface Body {
  text: string;
  phone: string;
}

export async function POST(req: Request) {
  if (!telegramBotConfigured()) {
    return fail("Set TELEGRAM_BOT_TOKEN in .env.local", 503);
  }

  const body = await readJson<Body>(req);
  const text = body?.text?.trim() ?? "";
  if (!text) return fail("Type a message to send");
  if (text.length > 4096) return fail("Message is too long for Telegram");

  const invalid = phoneError(body?.phone ?? "");
  if (invalid) return fail(invalid);

  await absorbTelegramStarts();
  const chatId = chatIdForPhone(body.phone);
  if (!chatId) {
    const known = Boolean(db.getUserByPhone(body.phone));
    return fail(
      known
        ? "That number hasn’t opened the Groupbet bot yet. Enable notifications (tap Start), then send again."
        : "No account for that number — they need to sign up and tap Start in Telegram first.",
      409,
    );
  }

  const sent = await sendTelegramMessage(chatId, text);
  if ("error" in sent) return fail(sent.error, 502);
  return ok({ ok: true as const, phone: body.phone, chatId });
}
