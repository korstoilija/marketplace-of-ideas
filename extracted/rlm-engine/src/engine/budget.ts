import type { Store } from "../store/store.js";

export class BudgetGuard {
  private store: Store;
  private dailyLimit: number;
  private runId: string;
  private runLimit: number;

  constructor(store: Store, opts?: { dailyLimit?: number; runLimit?: number; runId?: string }) {
    this.store = store;
    this.dailyLimit = opts?.dailyLimit ?? 1_000_000;
    this.runLimit = opts?.runLimit ?? 100_000;
    this.runId = opts?.runId ?? `run-${Date.now()}`;
  }

  spend(path: string, tokens = 1): void {
    this.store.spendTokens(path, tokens, this.runId);
  }

  dailyBudgetRemaining(): number {
    return Math.max(0, this.dailyLimit - this.store.tokensSpentToday());
  }

  runBudgetRemaining(): number {
    return Math.max(0, this.runLimit - this.store.tokensSpent(this.runId));
  }

  canSpend(tokens = 1): boolean {
    return this.dailyBudgetRemaining() >= tokens && this.runBudgetRemaining() >= tokens;
  }
}
