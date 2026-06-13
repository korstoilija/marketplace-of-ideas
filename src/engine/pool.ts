import type { Store } from "../store/store.js";

export interface AgentConfig {
  agentId: string;
  persona: string;
  provider: string;
  promptVersion: string;
  parentId: string | null;
  generation: number;
  active: boolean;
  createdAt: number;
}

export class AgentPool {
  private store: Store;
  readonly MIN_BALANCE = 50;   // Agents die below this
  readonly SPINUP_CAPITAL = 500; // New agents start with this
  readonly LLM_COST = 1;       // Each LLM call costs this many tokens
  readonly MAX_POPULATION = 16;

  constructor(store: Store) {
    this.store = store;
    this.ensureSchema();
  }

  private ensureSchema() {
    this.store.db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_configs (
        agent_id TEXT PRIMARY KEY,
        persona TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'deepseek',
        prompt_version TEXT NOT NULL DEFAULT 'v2',
        parent_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `).run();
  }

  /** Charge an agent for an LLM call. Returns false if they can't pay. */
  charge(agentId: string, tokens = this.LLM_COST): boolean {
    const a = this.store.getAgent(agentId);
    if (!a || a.balance < tokens) return false;
    this.store.db.prepare("UPDATE agents SET balance = balance - ? WHERE agent_id = ?").run(tokens, agentId);
    return true;
  }

  /** List active agents, ranked by reputation. */
  listActive(): AgentConfig[] {
    const rows = this.store.db.prepare(`
      SELECT ac.*, a.reputation, a.balance
      FROM agent_configs ac
      LEFT JOIN agents a ON ac.agent_id = a.agent_id
      WHERE ac.active = 1
      ORDER BY a.reputation DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      agentId: r["agent_id"] as string,
      persona: r["persona"] as string,
      provider: r["provider"] as string,
      promptVersion: r["prompt_version"] as string,
      parentId: (r["parent_id"] as string) || null,
      generation: r["generation"] as number,
      active: (r["active"] as number) === 1,
      createdAt: r["created_at"] as number,
    }));
  }

  /** Spawn a new agent with startup capital. */
  spawn(persona: string, provider = "deepseek", parentId: string | null = null): string {
    const gen = parentId
      ? ((this.store.db.prepare("SELECT generation FROM agent_configs WHERE agent_id=?").get(parentId) as { generation: number } | undefined)?.generation ?? 0) + 1
      : 0;
    const agentId = `${provider}-g${gen}-${Date.now().toString(36)}`;
    this.store.ensureAgent(agentId, this.SPINUP_CAPITAL);
    this.store.db.prepare(
      "INSERT INTO agent_configs (agent_id, persona, provider, prompt_version, parent_id, generation, active, created_at) VALUES (?,?,?,?,?,?,1,?)",
    ).run(agentId, persona, provider, "v2", parentId, gen, Date.now());
    return agentId;
  }

  /** Mutate a persona for child agent diversity. Fisher: variance = evolution rate. */
  mutatePersona(persona: string): string {
    const mutations = [
      "bet harder against consensus",
      "demand quantitative evidence only",
      "hunt for edge case counterexamples",
      "trust market prices more than own judgment",
      "prefer high-variance claims (ambiguous=opportunity)",
      "short every claim above 0.8 price",
    ];
    const m = mutations[Math.floor(Math.random() * mutations.length)];
    return `${persona}; also, ${m}`;
  }

  /** Bankruptcy sweep: kill agents that can't sustain themselves. */
  sweepBankrupt(): string[] {
    const died: string[] = [];
    for (const a of this.listActive()) {
      const agent = this.store.getAgent(a.agentId);
      if (!agent) continue;
      // Death: can't pay for even one LLM call AND no track record
      if (agent.balance < this.MIN_BALANCE && agent.reputation < 0.35) {
        this.store.db.prepare("UPDATE agent_configs SET active=0 WHERE agent_id=?").run(a.agentId);
        died.push(a.agentId);
      }
    }
    return died;
  }

  /** Fisher's theorem: evolution rate = variance in fitness. */
  fisherVariance(): number {
    const reps = this.listActive().map(a => this.store.getAgent(a.agentId)?.reputation ?? 0.5);
    if (reps.length < 2) return 0;
    const mean = reps.reduce((s, r) => s + r, 0) / reps.length;
    return reps.reduce((s, r) => s + (r - mean) ** 2, 0) / reps.length;
  }

  /** Full lifecycle: kill the weak, reproduce the strong. */
  lifecycle(): { died: string[]; born: string[]; fisherVariance: number } {
    const died = this.sweepBankrupt();
    const active = this.listActive();
    const born: string[] = [];

    // Reproduce from top performers to maintain diversity
    const ranked = [...active].sort((a, b) => {
      return (this.store.getAgent(b.agentId)?.reputation ?? 0) - (this.store.getAgent(a.agentId)?.reputation ?? 0);
    });

    const need = Math.max(0, this.MAX_POPULATION / 3 - active.length);
    for (let i = 0; i < need; i++) {
      const parent = ranked[i % Math.max(1, ranked.length)];
      const childId = this.spawn(this.mutatePersona(parent.persona), parent.provider, parent.agentId);
      born.push(childId);
    }

    return { died, born, fisherVariance: this.fisherVariance() };
  }
}
