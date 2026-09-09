/**
 * /api/debug/status — which messaging providers are wired up.
 */

import { ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import {
  telegramBotConfigured,
  telegramGatewayConfigured,
} from "@/lib/integrations/telegram";

export async function GET() {
  const user = await getCurrentUser();
  return ok({
    telegramBot: telegramBotConfigured(),
    telegramGateway: telegramGatewayConfigured(),
    linkedChatId: Boolean(user?.telegramChatId),
  });
}
