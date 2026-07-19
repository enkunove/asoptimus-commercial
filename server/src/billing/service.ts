// @aso/server/billing — wallet (D4 v4: usage-based, REAL-TIME debiting).
//
// Model:
//  • 1 credit = $1. NO free tier. Top-up only (Stripe, $1/credit).
//  • The moment a keyword becomes a verified keyphrase (rated, R≥1, part of the sample) —
//    pricePerKeyphrase[model] is debited atomically RIGHT THEN: `UPDATE wallet SET balance=balance-:p WHERE
//    balance>=:p`. Idempotent by (run_id, keyword) in the ledger (type=debit). After every debit
//    the updated balance is pushed to the client.
//  • NO upfront reserve. NO end-of-run settle/refund. Overshoot (up to +10%) IS PAID FOR (usage).
//  • Hard-stop at zero: balance doesn't cover the next keyphrase → run paused, resumable.
//    Debits on one wallet are serialized via atomic `WHERE balance>=:p` / FOR UPDATE (can't go
//    negative). Internal per-attempt token COGS (llm_steps) does NOT touch the wallet.

import type { Store } from "../db/index.ts";

export class InsufficientCredits extends Error {
  constructor(public needCredits: number, public haveCredits: number) {
    super(`insufficient credits: need ${Math.max(0, needCredits - haveCredits).toFixed(2)} more (have ${haveCredits.toFixed(2)}, keyphrase costs ${needCredits})`);
    this.name = "InsufficientCredits";
  }
}

/** Real COGS systematically overran the run's estimated ceiling — margin fuse (D4). */
export class CogsExceededCeiling extends Error {
  constructor(public cogsUsd: number, public ceilingCredits: number) {
    super(`internal COGS ($${cogsUsd.toFixed(2)}) exceeded the run ceiling (${ceilingCredits} cr.) — safety pause`);
    this.name = "CogsExceededCeiling";
  }
}

export class BillingService {
  constructor(private store: Store) {}

  async balance(userId: string): Promise<number> {
    return this.store.getBalance(userId);
  }

  /**
   * Debit one verified keyphrase IN REAL TIME (D4 v4). Atomic and idempotent by
   * (run_id, keyword). Returns: charged — debited just now; alreadyCharged — was already debited
   * (replay/repeat rating); otherwise (balance too low) — not debited, hard-stop at the caller.
   */
  async chargeKeyphrase(userId: string, runId: string, keyword: string, price: number): Promise<{ charged: boolean; alreadyCharged: boolean; balance: number }> {
    return this.store.debitForKeyphrase(userId, runId, keyword, price);
  }

  /** Credit grant (Stripe top-up), idempotent by stripe_event_id (D4/§webhooks). */
  async grant(userId: string, credits: number, stripeEventId: string | null): Promise<boolean> {
    const r = await this.store.grantCredits(userId, credits, stripeEventId);
    return r.granted;
  }
}
