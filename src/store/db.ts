import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    balance REAL NOT NULL,
    reputation REAL NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    parent_id TEXT,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
  )`,
  `CREATE TABLE IF NOT EXISTS idea_approvals (
    idea_id TEXT PRIMARY KEY REFERENCES ideas(id),
    approved INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT NOT NULL DEFAULT 'human',
    approved_at INTEGER,
    mechanism TEXT NOT NULL DEFAULT '',
    falsification TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS judge_criteria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    criterion TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS budget_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 1,
    run_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS score_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL,
    outcome INTEGER,
    brier REAL,
    prompt_version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL REFERENCES ideas(id),
    ord INTEGER NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    excerpt TEXT NOT NULL,
    stance TEXT NOT NULL CHECK (stance IN ('supporting','counter')),
    source_url TEXT,
    relevance REAL NOT NULL DEFAULT 0.5,
    submitted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS markets (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    q_yes REAL NOT NULL DEFAULT 0,
    q_no REAL NOT NULL DEFAULT 0,
    b REAL NOT NULL,
    resolution TEXT CHECK (resolution IN ('true','false')),
    resolved_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS positions (
    claim_id TEXT NOT NULL REFERENCES claims(id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    side TEXT NOT NULL CHECK (side IN ('yes','no')),
    shares REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (claim_id, agent_id, side)
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    side TEXT NOT NULL,
    shares REAL NOT NULL,
    cost REAL NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nominations (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ruled','skipped')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS adjudications (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    outcome INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'click',
    ruled_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS training_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    supporting_json TEXT NOT NULL,
    counter_json TEXT NOT NULL,
    outcome INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS optimizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baseline REAL NOT NULL,
    optimized REAL NOT NULL,
    examples_used INTEGER NOT NULL,
    holdout_size INTEGER NOT NULL,
    program_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS agent_iterations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    iteration INTEGER NOT NULL,
    code TEXT NOT NULL,
    stdout TEXT NOT NULL,
    timed_out INTEGER NOT NULL DEFAULT 0,
    has_final INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'file',
    last_hash TEXT,
    last_mtime INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('idea','claim','vault','tier1')),
    ref_id TEXT NOT NULL,
    vector BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'mini',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tier1_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id),
    text TEXT NOT NULL,
    claims_json TEXT NOT NULL DEFAULT '[]',
    max_similarity REAL,
    confidence REAL,
    coherence_score REAL,
    escalated INTEGER NOT NULL DEFAULT 0,
    run_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS interpretations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT REFERENCES claims(id),
    kind TEXT NOT NULL CHECK(kind IN ('ruling','new_claim','taste')),
    confidence REAL,
    reason TEXT,
    quote TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS taste_statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vault_entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'human',
    value REAL NOT NULL DEFAULT 0.5,
    lineage_json TEXT NOT NULL DEFAULT '[]',
    accepted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bounties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_entry_id TEXT REFERENCES vault_entries(id),
    agent_id TEXT NOT NULL,
    amount REAL NOT NULL,
    delta_diversity REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const ddl of TABLES) db.prepare(ddl).run();
  ensureIndexes(db);
  ensureColumns(db);
  return db;
}

function ensureIndexes(db: Db) {
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_orders_claim ON orders(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_iteration ON orders(iteration)",
    "CREATE INDEX IF NOT EXISTS idx_positions_agent ON positions(agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_verdicts_claim ON verdicts(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_iterations_session ON agent_iterations(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_nominations_status ON nominations(status)",
    "CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution)",
    "CREATE INDEX IF NOT EXISTS idx_claims_idea ON claims(idea_id)",
    "CREATE INDEX IF NOT EXISTS idx_adjudications_claim ON adjudications(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_training_examples_claim ON training_examples(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_lookup ON embeddings(kind, ref_id)",
    "CREATE INDEX IF NOT EXISTS idx_tier1_run ON tier1_items(run_id, escalated)",
    "CREATE INDEX IF NOT EXISTS idx_interpretations_claim ON interpretations(claim_id)",
    "CREATE INDEX IF NOT EXISTS idx_interpretations_status ON interpretations(status)",
    "CREATE INDEX IF NOT EXISTS idx_bounties_vault ON bounties(vault_entry_id)",
    "CREATE INDEX IF NOT EXISTS idx_bounties_agent ON bounties(agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path)",
  ];
  for (const idx of indexes) db.prepare(idx).run();
}

function ensureColumns(db: Db) {
  const alter = (table: string, column: string, defn: string) => {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${defn}`).run(); } catch { /* column already exists */ }
  };
  alter("adjudications", "confidence", "REAL NOT NULL DEFAULT 1.0");
  alter("adjudications", "reason", "TEXT NOT NULL DEFAULT ''");
  alter("adjudications", "source", "TEXT NOT NULL DEFAULT 'click'");
  alter("training_examples", "confidence", "REAL NOT NULL DEFAULT 1.0");
}
