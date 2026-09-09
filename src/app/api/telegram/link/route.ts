/**
 * /api/telegram/link — start linking the signed-in user to the bot.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { newGroupCode } from "@/lib/ids";
import { getBotUsername, telegramBotConfigured } from "@/lib/integrations/telegram";
import { verifyDb } from "@/lib/verify-store";

interface Body {
  username?: string;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const body = await readJson<Body>(req);
  const username = body?.username?.trim().replace(/^@/, "") || undefined;
  if (username) {
    db.updateUser(user.id, { telegramUsername: username });
  }

  if (!telegramBotConfigured()) {
    return ok({
      linked: Boolean(user.telegramChatId),
      username: username ?? user.telegramUsername,
      botUsername: null as string | null,
      deepLink: null as string | null,
      code: null as string | null,
    });
  }

  const code = newGroupCode();
  verifyDb.putLink({
    code,
    userId: user.id,
    expiresAt: Date.now() + 15 * 60_000,
  });

  const botUsername = await getBotUsername();
  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=${code}`
    : null;

  return ok({
    linked: Boolean(user.telegramChatId),
    username: username ?? user.telegramUsername,
    botUsername: botUsername ?? null,
    deepLink,
    code,
  });
}
