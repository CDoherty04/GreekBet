/**
 * /api/telegram/sync — poll bot /start messages and attach chat ids.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { telegramBotConfigured } from "@/lib/integrations/telegram";
import { absorbTelegramStarts } from "@/lib/telegram-link";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!telegramBotConfigured()) {
    return fail("Set TELEGRAM_BOT_TOKEN in .env.local", 503);
  }

  const absorbed = await absorbTelegramStarts();
  if (absorbed.error) return fail(absorbed.error, 502);

  const fresh = (await db.getUser(user.id))!;
  return ok({
    matched: Boolean(fresh.telegramChatId),
    linked: absorbed.linked,
    telegramChatId: fresh.telegramChatId ?? null,
    telegramUsername: fresh.telegramUsername ?? null,
  });
}
