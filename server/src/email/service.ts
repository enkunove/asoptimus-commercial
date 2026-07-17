// @aso/server/email — провайдеро-агностичный SMTP-сервис (BUILD-PLAN §9). Транзакционные письма:
// активационный ключ (на /signup) и чеки об оплате (на Stripe-webhook). Конфиг — ТОЛЬКО env:
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM (любой транзакционный SMTP-relay).
// В ПРОДЕ отсутствие SMTP → жёсткий отказ (письма не теряем молча). DEV=1 без SMTP → лог-only.

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
    "Спасибо за интерес к ASOptimus!",
    "",
    "Ваш активационный ключ:",
    "",
    `    ${key}`,
    "",
    "Вставьте его в программе при первом запуске. Ключ привязывается к устройству.",
    "Оплата — по факту (кредиты списываются за проверенные кейфразы). Пополнить баланс можно",
    "в самой программе.",
  ].join("\n");
  return { to, subject: "Ваш ключ активации ASOptimus", text };
}

function receiptEmail(to: string, credits: number, chargeUsd: number, balance: number): EmailMessage {
  const text = [
    "Спасибо за пополнение ASOptimus!",
    "",
    `Начислено кредитов: ${credits} (оплачено $${chargeUsd.toFixed(2)}, 1 кредит = $1).`,
    `Текущий баланс: ${balance.toFixed(2)} кредитов.`,
    "",
    "Кредиты списываются за проверенные кейфразы по ходу прогона.",
  ].join("\n");
  return { to, subject: "Чек ASOptimus — пополнение баланса", text };
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
      secure: port === 465, // 465 = implicit TLS; 587/25 = STARTTLS (nodemailer поднимает сам)
      auth: user ? { user, pass } : undefined,
    });
    this.from = from;
  }

  async send(msg: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    log.info("[email] отправлено", { to: msg.to, subject: msg.subject });
  }
  async sendActivationKey(to: string, key: string) { await this.send(activationEmail(to, key)); }
  async sendReceipt(to: string, credits: number, chargeUsd: number, balance: number) {
    await this.send(receiptEmail(to, credits, chargeUsd, balance));
  }
}

class DevLogEmailService implements EmailService {
  readonly kind = "dev-log" as const;
  async send(msg: EmailMessage): Promise<void> {
    log.warn("[email] DEV-log (SMTP не задан; письмо НЕ отправлено)", { to: msg.to, subject: msg.subject, preview: msg.text.slice(0, 160) });
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
    log.warn("[email] DEV-log EmailService (SMTP_HOST не задан)");
    return new DevLogEmailService();
  }
  throw new ProdConfigError("SMTP_HOST", "транзакционный SMTP-relay для писем (ключ активации + чеки)");
}
