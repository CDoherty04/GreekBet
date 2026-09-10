/**
 * In-memory Telegram-link state (separate from the main store so a hot reload
 * of seed data doesn't wipe a code the user just received).
 */

import type { ID } from "@/types";

export interface TelegramLinkCode {
  code: string;
  userId: ID;
  expiresAt: number;
}

interface VerifyStore {
  linkCodes: Map<string, TelegramLinkCode>;
  /** phone (E.164) → Telegram chat id after the user taps Start. */
  chatByPhone: Map<string, string>;
  tgOffset: number;
}

const globalForVerify = globalThis as unknown as { __groupbetVerify?: VerifyStore };

const verifyStore: VerifyStore = (globalForVerify.__groupbetVerify ??= {
  linkCodes: new Map(),
  chatByPhone: new Map(),
  tgOffset: 0,
});
verifyStore.chatByPhone ??= new Map();
verifyStore.linkCodes ??= new Map();

export const verifyDb = {
  putLink(link: TelegramLinkCode): void {
    verifyStore.linkCodes.set(link.code, link);
  },
  getLink(code: string): TelegramLinkCode | undefined {
    return verifyStore.linkCodes.get(code);
  },
  consumeLink(code: string): TelegramLinkCode | undefined {
    const link = verifyStore.linkCodes.get(code);
    if (link) verifyStore.linkCodes.delete(code);
    return link;
  },
  setChatByPhone(phone: string, chatId: string): void {
    verifyStore.chatByPhone.set(phone, chatId);
  },
  getChatByPhone(phone: string): string | undefined {
    return verifyStore.chatByPhone.get(phone);
  },
  getTgOffset(): number {
    return verifyStore.tgOffset;
  },
  setTgOffset(offset: number): void {
    verifyStore.tgOffset = offset;
  },
};
