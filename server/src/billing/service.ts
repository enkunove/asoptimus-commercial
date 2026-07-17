// @aso/server/billing — кошелёк (D4 v4: usage-based, списание в РЕАЛЬНОМ ВРЕМЕНИ).
//
// Модель:
//  • 1 кредит = $1. Free-tier НЕТ. Только пополнение (Stripe, $1/кредит).
//  • Как только кейворд становится проверенной кейфразой (rated, R≥1, входит в выборку) — ТУТ ЖЕ
//    атомарно списывается pricePerKeyphrase[model]: `UPDATE wallet SET balance=balance-:p WHERE
//    balance>=:p`. Идемпотентно по (run_id, keyword) в ledger (type=debit). После каждого списания
//    клиенту пушится обновлённый баланс.
//  • НЕТ апфронт-резерва. НЕТ end-of-run settle/refund. Overshoot (до +10%) ОПЛАЧИВАЕТСЯ (usage).
//  • Hard-stop на нуле: баланс не покрывает следующую кейфразу → прогон paused, резюмируемо.
//    Сериализация списаний одного кошелька — атомарным `WHERE balance>=:p` / FOR UPDATE (в минус
//    не уйти). Внутренний per-attempt token-COGS (llm_steps) НЕ трогает кошелёк.

import type { Store } from "../db/index.ts";

export class InsufficientCredits extends Error {
  constructor(public needCredits: number, public haveCredits: number) {
    super(`недостаточно кредитов: нужно ещё ${Math.max(0, needCredits - haveCredits).toFixed(2)} (есть ${haveCredits.toFixed(2)}, кейфраза стоит ${needCredits})`);
    this.name = "InsufficientCredits";
  }
}

/** Реальный COGS системно вылез за оценочный потолок прогона — предохранитель маржи (D4). */
export class CogsExceededCeiling extends Error {
  constructor(public cogsUsd: number, public ceilingCredits: number) {
    super(`внутренний COGS ($${cogsUsd.toFixed(2)}) вышел за потолок прогона (${ceilingCredits} кр.) — предохранительная пауза`);
    this.name = "CogsExceededCeiling";
  }
}

export class BillingService {
  constructor(private store: Store) {}

  async balance(userId: string): Promise<number> {
    return this.store.getBalance(userId);
  }

  /**
   * Списать одну проверенную кейфразу В РЕАЛЬНОМ ВРЕМЕНИ (D4 v4). Атомарно и идемпотентно по
   * (run_id, keyword). Возврат: charged — списали сейчас; alreadyCharged — уже была списана
   * (реплей/повторный рейт); иначе (баланс мал) — не списано, hard-stop у вызывающего.
   */
  async chargeKeyphrase(userId: string, runId: string, keyword: string, price: number): Promise<{ charged: boolean; alreadyCharged: boolean; balance: number }> {
    return this.store.debitForKeyphrase(userId, runId, keyword, price);
  }

  /** Грант кредитов (Stripe top-up), идемпотентно по stripe_event_id (D4/§webhooks). */
  async grant(userId: string, credits: number, stripeEventId: string | null): Promise<boolean> {
    const r = await this.store.grantCredits(userId, credits, stripeEventId);
    return r.granted;
  }
}
