/**
 * In-memory OTP + Telegram-link state (separate from the main store so a
 * hot reload of seed data doesn't wipe a code the user just received).
 */

import type { ID } from "@/types";
import type { VerifyChannel } from "@/lib/integrations/telegram";

export interface PendingOtp {
  phone: string;
  /** Local code for the stub. Gateway-generated codes live at Telegram. */
  code?: string;
  requestId?: string;
  channel: VerifyChannel;
  expiresAt: number;
  sentAt: number;
  attempts: number;
}

export interface TelegramLinkCode {
  code: string;
  userId: ID;
  expiresAt: number;
}

interface VerifyStore {
  otps: Map<string, PendingOtp>;
  verified: Map<string, number>;
  linkCodes: Map<string, TelegramLinkCode>;
  /** phone (E.164) → Telegram chat id after the user taps Start. */
  chatByPhone: Map<string, string>;
  tgOffset: number;
}

const globalForVerify = globalThis as unknown as { __groupbetVerify?: VerifyStore };

const verifyStore: VerifyStore = (globalForVerify.__groupbetVerify ??= {
  otps: new Map(),
  verified: new Map(),
  linkCodes: new Map(),
  chatByPhone: new Map(),
  tgOffset: 0,
});
verifyStore.chatByPhone ??= new Map();

export const verifyDb = {
  getOtp(phone: string): PendingOtp | undefined {
    return verifyStore.otps.get(phone);
  },
  setOtp(otp: PendingOtp): void {
    verifyStore.otps.set(otp.phone, otp);
  },
  clearOtp(phone: string): void {
    verifyStore.otps.delete(phone);
  },
  markVerified(phone: string, until: number): void {
    verifyStore.verified.set(phone, until);
  },
  isVerified(phone: string): boolean {
    const until = verifyStore.verified.get(phone);
    return Boolean(until && until > Date.now());
  },
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
