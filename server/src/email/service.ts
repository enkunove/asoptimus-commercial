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
  sendActivationKey(to: string, key: string): Promise<void>;
  sendReceipt(to: string, credits: number, chargeUsd: number, balance: number): Promise<void>;
  readonly kind: "smtp" | "dev-log";
}

const FROM_FALLBACK = "ASOptimus <noreply@asoptimus.com>";

function activationEmail(to: string, key: string): EmailMessage {
  const text = [
    "Thank you for your interest in ASOptimus!",
    "",
    "Your activation key:",
    "",
    `    ${key}`,
    "",
    "Enter it in the app on first launch. The key is bound to your device.",
    "Billing is usage-based (credits are debited per verified keyphrase). You can top up",
    "your balance right in the app.",
  ].join("\n");
  return { to, subject: "Your ASOptimus activation key", text };
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
  async sendActivationKey(to: string, key: string) { await this.send(activationEmail(to, key)); }
  async sendReceipt(to: string, credits: number, chargeUsd: number, balance: number) {
    await this.send(receiptEmail(to, credits, chargeUsd, balance));
  }
}

class DevLogEmailService implements EmailService {
  readonly kind = "dev-log" as const;
  async send(msg: EmailMessage): Promise<void> {
    log.warn("[email] DEV-log (SMTP not configured; email NOT sent)", { to: msg.to, subject: msg.subject, preview: msg.text.slice(0, 160) });
  }
  async sendActivationKey(to: string, key: string) { await this.send(activationEmail(to, key)); }
  async sendReceipt(to: string, credits: number, chargeUsd: number, balance: number) {
    await this.send(receiptEmail(to, credits, chargeUsd, balance));
  }
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
