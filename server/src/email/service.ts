// @aso/server/email — provider-agnostic SMTP service (BUILD-PLAN §9). Transactional emails:
// activation key (on /signup) and payment receipts (on Paddle webhook). Config — env ONLY:
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM (any transactional SMTP relay).
// In PROD, missing SMTP → hard failure (we don't silently drop emails). DEV=1 without SMTP → log-only.

import { IS_DEV, ProdConfigError, optionalEnv, hasEnv } from "../env.ts";
import { log } from "../log.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailService {
  send(msg: EmailMessage): Promise<void>;
  /** freeCredits: beta welcome grant already on the key (mentioned in the email when set). */
  sendActivationKey(to: string, key: string, freeCredits?: number): Promise<void>;
  sendReceipt(to: string, credits: number, chargeUsd: number, balance: number): Promise<void>;
  /** Beta invite: "sign up with this email at asoptimus.com → key + free credits". */
  sendBetaInvite(to: string, grantCredits: number): Promise<void>;
  readonly kind: "smtp" | "dev-log";
}

const FROM_FALLBACK = "ASOptimus <noreply@asoptimus.com>";

function activationEmail(to: string, key: string, freeCredits?: number): EmailMessage {
  const text = [
    "Thank you for your interest in ASOptimus!",
    "",
    "Your activation key:",
    "",
    `    ${key}`,
    "",
    ...(freeCredits ? [
      `Your beta balance: $${freeCredits} in credits is already on this key — free, no card needed.`,
      "",
    ] : []),
    "Enter it in the app on first launch. The key is bound to your device.",
    "Billing is usage-based (credits are debited per verified keyphrase). You can top up",
    "your balance right in the app.",
  ].join("\n");
  return { to, subject: "Your ASOptimus activation key", text };
}

function betaInviteEmail(to: string, grantCredits: number): EmailMessage {
  const text = [
    "You're in — the ASOptimus private beta is opening for you.",
    "",
    "ASOptimus finds the best App Store keywords for YOUR app specifically:",
    "measured demand, measured difficulty, honest numbers you can audit.",
    "",
    "How to claim your access:",
    "",
    `  1. Go to https://asoptimus.com and sign up with THIS email address (${to}).`,
    `  2. Your activation key arrives instantly — with $${grantCredits} in credits`,
    "     already on it. Free, no card needed.",
    "  3. Download the app, paste the key, run your first keyword analysis.",
    "",
    "The invite is personal to this email address.",
  ].join("\n");
  return { to, subject: "Your ASOptimus beta invite — $" + grantCredits + " in credits inside", text };
}

function receiptEmail(to: string, credits: number, chargeUsd: number, balance: number): EmailMessage {
  const text = [
    "Thank you for topping up ASOptimus!",
    "",
    `Credits granted: ${credits} (paid $${chargeUsd.toFixed(2)}, 1 credit = $1).`,
    `Current balance: ${balance.toFixed(2)} credits.`,
    "",
    "Credits are debited per verified keyphrase as the run progresses.",
  ].join("\n");
  return { to, subject: "ASOptimus receipt — balance top-up", text };
}

class SmtpEmailService implements EmailService {
  readonly kind = "smtp" as const;
  private transport: any;
  private from: string;

  constructor(host: string, port: number, user: string, pass: string, from: string) {
    const nodemailer = require("nodemailer");
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS; 587/25 = STARTTLS (nodemailer handles it)
      auth: user ? { user, pass } : undefined,
    });
    this.from = from;
  }

  async send(msg: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    log.info("[email] sent", { to: msg.to, subject: msg.subject });
  }
  async sendActivationKey(to: string, key: string, freeCredits?: number) { await this.send(activationEmail(to, key, freeCredits)); }
  async sendReceipt(to: string, credits: number, chargeUsd: number, balance: number) {
    await this.send(receiptEmail(to, credits, chargeUsd, balance));
  }
  async sendBetaInvite(to: string, grantCredits: number) { await this.send(betaInviteEmail(to, grantCredits)); }
}

class DevLogEmailService implements EmailService {
  readonly kind = "dev-log" as const;
  async send(msg: EmailMessage): Promise<void> {
    log.warn("[email] DEV-log (SMTP not configured; email NOT sent)", { to: msg.to, subject: msg.subject, preview: msg.text.slice(0, 160) });
  }
  async sendActivationKey(to: string, key: string, freeCredits?: number) { await this.send(activationEmail(to, key, freeCredits)); }
  async sendReceipt(to: string, credits: number, chargeUsd: number, balance: number) {
    await this.send(receiptEmail(to, credits, chargeUsd, balance));
  }
  async sendBetaInvite(to: string, grantCredits: number) { await this.send(betaInviteEmail(to, grantCredits)); }
}

export function createEmailService(): EmailService {
  if (hasEnv("SMTP_HOST")) {
    const host = optionalEnv("SMTP_HOST");
    const port = Number(optionalEnv("SMTP_PORT", "587"));
    const user = optionalEnv("SMTP_USER");
    const pass = optionalEnv("SMTP_PASS");
    const from = optionalEnv("SMTP_FROM", FROM_FALLBACK);
    log.info("[email] SMTP", { host, port, from });
    return new SmtpEmailService(host, port, user, pass, from);
  }
  if (IS_DEV) {
    log.warn("[email] DEV-log EmailService (SMTP_HOST not set)");
    return new DevLogEmailService();
  }
  throw new ProdConfigError("SMTP_HOST", "transactional SMTP relay for emails (activation key + receipts)");
}
