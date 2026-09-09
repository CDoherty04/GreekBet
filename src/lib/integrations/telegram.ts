/**
 * Telegram — bot DMs + Gateway phone verification.
 *
 * Two APIs, same file:
 *   1. Gateway API — OTP to a phone number registered on Telegram.
 *   2. Bot API — event notifications after the user taps Start once.
 *
 * Tokens live in env (see `.env.example`). Missing Gateway token → OTP
 * falls through to an in-app stub so the demo still runs.
 */

export type VerifyChannel = "telegram" | "stub";

interface GatewayOk {
  ok: true;
  result: {
    request_id: string;
    verification_status?: { status: string };
  };
}

interface GatewayErr {
  ok: false;
  error?: string;
}

type GatewayResponse = GatewayOk | GatewayErr;

interface BotOk<T> {
  ok: true;
  result: T;
}

interface BotErr {
  ok: false;
  description?: string;
}

function botToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

function gatewayToken(): string | undefined {
  return process.env.TELEGRAM_GATEWAY_TOKEN?.trim() || undefined;
}

export function telegramBotConfigured(): boolean {
  return Boolean(botToken());
}

export function telegramGatewayConfigured(): boolean {
  return Boolean(gatewayToken());
}

async function gateway<T extends GatewayResponse>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = gatewayToken();
  if (!token) throw new Error("TELEGRAM_GATEWAY_TOKEN is not set");
  const res = await fetch(`https://gatewayapi.telegram.org/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function botApi<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<BotOk<T> | BotErr> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as BotOk<T> | BotErr;
}

/** Send a verification code to a phone via Telegram Gateway. */
export async function sendGatewayCode(
  phone: string,
): Promise<{ requestId: string } | { error: string }> {
  try {
    const data = await gateway<GatewayResponse>("sendVerificationMessage", {
      phone_number: phone,
      code_length: 6,
      ttl: 120,
    });
    if (!data.ok) return { error: data.error ?? "Telegram could not text that number" };
    return { requestId: data.result.request_id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Telegram Gateway failed" };
  }
}

/** Confirm a Gateway-generated code. */
export async function checkGatewayCode(
  requestId: string,
  code: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const data = await gateway<GatewayResponse>("checkVerificationStatus", {
      request_id: requestId,
      code,
    });
    if (!data.ok) return { valid: false, error: data.error ?? "Could not check code" };
    const status = data.result.verification_status?.status;
    return { valid: status === "code_valid", error: status === "code_valid" ? undefined : status };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Telegram Gateway failed" };
  }
}

/** Post a chat message from the bot. */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const data = await botApi<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
    });
    if (!data.ok) return { error: data.description ?? "Telegram send failed" };
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Telegram send failed" };
  }
}

export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

/** Ping linked members about a new event. Failures are ignored. */
export async function notifyNewEvent(input: {
  chatIds: string[];
  groupName: string;
  title: string;
  url: string;
}): Promise<void> {
  if (!telegramBotConfigured() || input.chatIds.length === 0) return;
  const text = `New event in ${input.groupName}\n\n${input.title}\n${input.url}`;
  await Promise.allSettled(
    input.chatIds.map((chatId) => sendTelegramMessage(chatId, text)),
  );
}

export async function getBotUsername(): Promise<string | undefined> {
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (fromEnv) return fromEnv;
  if (!botToken()) return undefined;
  try {
    const data = await botApi<{ username?: string }>("getMe");
    if (data.ok) return data.result.username;
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface TelegramStartMessage {
  chatId: string;
  username?: string;
  payload: string;
  updateId: number;
}

/**
 * Pull new bot updates and return `/start <code>` (or a bare link code)
 * messages so we can attach a chat id to a user.
 */
export async function pullStartMessages(
  offset: number,
): Promise<{ messages: TelegramStartMessage[]; nextOffset: number } | { error: string }> {
  try {
    const data = await botApi<
      Array<{
        update_id: number;
        message?: {
          text?: string;
          chat: { id: number };
          from?: { username?: string };
        };
      }>
    >("getUpdates", { offset, timeout: 0 });
    if (!data.ok) return { error: data.description ?? "Could not read bot updates" };

    const messages: TelegramStartMessage[] = [];
    let nextOffset = offset;
    for (const update of data.result) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      const text = update.message?.text?.trim() ?? "";
      const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
      const bare = text.match(/^([A-Z0-9]{6})$/i);
      const payload = (start?.[1] ?? bare?.[1] ?? "").toUpperCase();
      if (!payload || !update.message) continue;
      messages.push({
        chatId: String(update.message.chat.id),
        username: update.message.from?.username,
        payload,
        updateId: update.update_id,
      });
    }
    return { messages, nextOffset };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read bot updates" };
  }
}
