/**
 * Attach Telegram chat ids to users after they tap Start on the bot.
 */

import { db } from "@/lib/store";
import { normalizePhone } from "@/lib/phone";
import { pullStartMessages } from "@/lib/integrations/telegram";
import { verifyDb } from "@/lib/verify-store";

/** Consume new /start messages and remember chat id by user + phone. */
export async function absorbTelegramStarts(): Promise<{
  linked: number;
  error?: string;
}> {
  const pulled = await pullStartMessages(verifyDb.getTgOffset());
  if ("error" in pulled) return { linked: 0, error: pulled.error };

  verifyDb.setTgOffset(pulled.nextOffset);
  let linked = 0;
  for (const msg of pulled.messages) {
    const pending = verifyDb.getLink(msg.payload);
    if (!pending || pending.expiresAt < Date.now()) continue;
    const owner = db.getUser(pending.userId);
    if (!owner) continue;
    db.updateUser(owner.id, {
      telegramChatId: msg.chatId,
      telegramUsername: msg.username ?? owner.telegramUsername,
    });
    verifyDb.setChatByPhone(normalizePhone(owner.phone), msg.chatId);
    verifyDb.consumeLink(msg.payload);
    linked += 1;
  }
  return { linked };
}

export function chatIdForPhone(phone: string): string | undefined {
  const normalized = normalizePhone(phone);
  const user = db.getUserByPhone(normalized);
  return user?.telegramChatId || verifyDb.getChatByPhone(normalized);
}
