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
    ruled_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS training_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    supporting_json TEXT NOT NULL,
    counter_json TEXT NOT NULL,
    outcome INTEGER NOT NULL,
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
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const ddl of TABLES) db.prepare(ddl).run();
  return db;
}
