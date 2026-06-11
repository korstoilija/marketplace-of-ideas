import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../store/store.js";
import { buildAdjudicationCards } from "./cards.js";
import { runSession, type SessionResult } from "../engine/harness.js";
import type { CodeGenerator, LeafEvaluator } from "../engine/agent.js";
import { buildProviders, makeCodeGenerator, makeLeafEvaluator, makeLlm } from "../engine/codegen.js";
import { runGepa, loadLatestOptimization, InsufficientExamplesError, type GepaReport, MIN_EXAMPLES } from "../optimize/gepa.js";
import { selfImprove } from "./self-improve.js";
import { llmSearch } from "../engine/search.js";
import { computeMetrics } from "./metrics.js";
import { makeCliCodeGenerator } from "../engine/cli-provider.js";
import { compileRiff, confirmInterpretations } from "../refinery/riff.js";
import { scanSources, tier1Decompose } from "../refinery/cascade.js";
import { BudgetGuard } from "../engine/budget.js";

const PUBLIC_DIR = join(import.meta.dirname, "..", "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface TraderSetup { agentId: string; persona: string; codegen: CodeGenerator }
export interface TraderFactory {
  (count: number): { traders: TraderSetup[]; leafEvaluator: LeafEvaluator; llm: (p: string) => Promise<string> };
}

export interface ServiceConfig {
  store: Store;
  port: number;
  traderFactory?: TraderFactory;
  broadcastMs?: number;
  gepaRunner?: () => Promise<GepaReport>;
}

export interface Service {
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** Shared lifecycle for async background jobs: mutual exclusion, error capture, broadcast. */
class AsyncJob<T> {
  running = false;
  error: string | null = null;
  last: T | null = null;
  constructor(private broadcast: () => void) {}

  /** Start a job. Returns false if already running. The promise chain sets flags. */
  start(promise: Promise<T>, onSettled?: (result: T | null, error: string | null) => void): boolean {
    if (this.running) return false;
    this.running = true;
    this.error = null;
    promise
      .then(result => {
        this.last = result;
        onSettled?.(result, null);
      })
      .catch(err => {
        this.error = String(err instanceof Error ? err.message : err);
        onSettled?.(null, this.error);
      })
      .finally(() => {
        this.running = false;
        this.broadcast();
      });
    return true;
  }
}

const PERSONAS = [
  "ruthless skeptic; you demand evidence and bet against hype",
  "enthusiastic generalist; you hunt for upside others miss",
  "careful empiricist; you only trust verifiable specifics",
  "contrarian; you probe whatever the market already believes",
  "synthesizer; you connect claims across ideas",
];

function defaultTraderFactory(count: number): ReturnType<TraderFactory> {
  const providers = buildProviders();
  const cliTraders = (process.env["MP_CLI_TRADERS"] ?? "").split(",").map(s => s.trim()).filter((s): s is "claude" | "codex" => s === "claude" || s === "codex");
  if (providers.length === 0 && cliTraders.length === 0) throw new Error("no provider API keys set and no CLI traders enabled");
  
  const roster = cliTraders.length > 0 
    ? [...providers.map(p => ({ name: p.name, makeGen: () => makeCodeGenerator(p.llm) })), ...cliTraders.map(k => ({ name: k, makeGen: () => makeCliCodeGenerator(k) }))]
    : providers.map(p => ({ name: p.name, makeGen: () => makeCodeGenerator(p.llm) }));
  
  const traders: TraderSetup[] = Array.from({ length: count }, (_, i) => {
    const r = roster[i % roster.length];
    return {
      agentId: `${r.name}-${PERSONAS[i % PERSONAS.length].split(";")[0].replace(/\s+/g, "-")}`,
      persona: PERSONAS[i % PERSONAS.length],
      codegen: r.makeGen(),
    };
  });
  const primaryLlm = providers.length > 0 ? providers[0].llm : null;
  const leafEvaluator = primaryLlm ? makeLeafEvaluator(primaryLlm) : async () => ({ confidence: 0.5, reasoning: "no API provider available" });
  const llm = primaryLlm ? makeLlm(primaryLlm) : async (p: string) => `no API provider available for: ${p}`;
  return { traders, leafEvaluator, llm };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseFail(body: Record<string, unknown>): boolean {
  return body["_parseError"] === true;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1_000_000) body = ""; });
    req.on("end", () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { resolve({ _parseError: true }); }
    });
  });
}

interface OptimizeState {
  job: AsyncJob<GepaReport>;
  trainingExamples: number;
}

function snapshot(store: Store, session: AsyncJob<SessionResult>, optimize: OptimizeState) {
  const sessions = store.listSessions();
  const liveSession = sessions.find(s => !s.endedAt);
  const allLogs = liveSession
    ? store.getSessionIterations(liveSession.id).map(it => ({
        agentId: it.agentId,
        depth: it.depth,
        iteration: it.iteration,
        code: it.code.slice(0, 500),
        stdout: it.stdout.slice(0, 500),
        hasFinal: it.hasFinal,
        timedOut: it.timedOut,
        hasError: it.stdout.includes("ERROR") || it.stdout.includes("ReferenceError") || it.stdout.includes("TypeError"),
      }))
    : [];

  const allIdeas = store.listIdeas();
  const allDbIdeas = store.db.prepare("SELECT id, status FROM ideas").all() as Array<{ id: string; status: string }>;
  const statusMap = new Map(allDbIdeas.map(i => [i.id, i.status]));

  return {
    summary: store.counters(),
    agents: store.listAgents(),
    ideas: allIdeas.map(i => ({
      id: i.id,
      title: i.title,
      status: statusMap.get(i.id) || "proposed",
      approval: store.getApproval(i.id),
      claims: i.claimIds.map(cid => {
        const m = store.getMarket(cid);
        return {
          id: cid,
          text: store.getClaim(cid)?.text ?? "",
          yesPrice: m ? +m.yesPrice.toFixed(4) : 0.5,
          resolution: m?.resolution ?? null,
          orders: store.orderCount(cid),
        };
      }),
    })),
    pendingIdeas: allIdeas.filter(i => (statusMap.get(i.id) || "proposed") === "proposed").map(i => ({ id: i.id, title: i.title })),
    judgeCriteria: store.getJudgeCriteria(),
    queue: buildAdjudicationCards(store),
    recentOrders: store.recentOrders(15),
    allLogs,
    sessions: store.listSessions().slice(0, 10),
    metrics: computeMetrics(store),
    session: {
      running: session.running,
      error: session.error,
      lastRuns: session.last?.runs.map(r => ({
        agentId: r.agentId,
        iterations: r.iterations.length,
        final: r.final,
      })) ?? [],
    },
    trainingExamples: optimize.trainingExamples,
    minExamples: MIN_EXAMPLES,
    optimize: {
      running: optimize.job.running,
      error: optimize.job.error,
      last: optimize.job.last,
      history: store.listOptimizations().slice(0, 5),
    },
  };
}

export async function startService(cfg: ServiceConfig): Promise<Service> {
  const { store } = cfg;
  const traderFactory = cfg.traderFactory ?? defaultTraderFactory;
  loadLatestOptimization(store);

  let _broadcast: () => void;
  const session = new AsyncJob<SessionResult>(() => _broadcast?.());
  const optimize = new AsyncJob<GepaReport>(() => _broadcast?.());

  const defaultGepaRunner = async (): Promise<GepaReport> => {
    const providers = buildProviders();
    if (providers.length === 0) throw new Error("no provider API keys set");
    return runGepa({ store, llm: providers[0].llm });
  };
  const gepaRunner = cfg.gepaRunner ?? defaultGepaRunner;
  const optimizeState: OptimizeState = { job: optimize, trainingExamples: store.trainingExampleCount() };

  const server = createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const method = req.method ?? "GET";

    try {
      if (u === "/api/state" && method === "GET") return json(res, snapshot(store, session, optimizeState));
      if (u === "/api/queue" && method === "GET") return json(res, { cards: buildAdjudicationCards(store) });
      if (u === "/api/metrics" && method === "GET") return json(res, computeMetrics(store));

      if (u === "/api/export" && method === "GET") {
        const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("session");
        let rows = sessionId
          ? store.getSessionIterations(Number(sessionId))
          : (() => { const all: ReturnType<typeof store.getSessionIterations> = []; for (const s of store.listSessions().slice(0, 10)) all.push(...store.getSessionIterations(s.id)); return all; })();
        const jsonl = rows.map(r => JSON.stringify({ agentId: r.agentId, depth: r.depth, iteration: r.iteration, code: r.code, stdout: r.stdout, hasFinal: r.hasFinal })).join("\n");
        res.writeHead(200, { "Content-Type": "application/x-jsonlines", "Content-Disposition": "attachment; filename=transcripts.jsonl" });
        return void res.end(jsonl);
      }

      if (u === "/api/approve" && method === "POST") {
        const body = await readBody(req);
        const ideaId = String(body["ideaId"] ?? "");
        const mechanism = String(body["mechanism"] ?? "");
        const falsification = String(body["falsification"] ?? "");
        if (!store.getIdea(ideaId)) return json(res, { error: "unknown idea" }, 404);
        store.approveIdea(ideaId, mechanism, falsification);
        _broadcast();
        return json(res, { ok: true, ideaId, status: "accepted" });
      }
      if (u === "/api/dismiss" && method === "POST") {
        const body = await readBody(req);
        const ideaId = String(body["ideaId"] ?? "");
        if (!store.getIdea(ideaId)) return json(res, { error: "unknown idea" }, 404);
        store.dismissIdea(ideaId);
        _broadcast();
        return json(res, { ok: true, ideaId, status: "rejected" });
      }
      if (u === "/api/judge" && method === "POST") {
        const body = await readBody(req);
        if (parseFail(body)) return json(res, { error: "invalid JSON body" }, 400);
        const criteria = (body["criteria"] as Array<{ criterion: string; weight: number }>) ?? [];
        store.setJudgeCriteria(criteria);
        _broadcast();
        return json(res, { ok: true, count: criteria.length });
      }
      if (u === "/api/judge" && method === "GET") {
        return json(res, { criteria: store.getJudgeCriteria() });
      }

      if (u === "/api/sessions" && method === "GET") {
        return json(res, { sessions: store.listSessions() });
      }
      const sess = u.match(/^\/api\/sessions\/(\d+)$/);
      if (sess && method === "GET") {
        const id = Number(sess[1]);
        const meta = store.listSessions().find(s => s.id === id);
        if (!meta) return json(res, { error: `unknown session: ${id}` }, 404);
        return json(res, { session: meta, iterations: store.getSessionIterations(id) });
      }

      const hist = u.match(/^\/api\/history\/(.+)$/);
      if (hist && method === "GET") return json(res, { path: store.priceHistory(hist[1]) });

      if (u === "/api/adjudicate" && method === "POST") {
        const body = await readBody(req);
        // Batch mode: {rulings: [{claimId, ruling}, ...]}
        if (body["rulings"] && Array.isArray(body["rulings"])) {
          const rulings = body["rulings"] as Array<{ claimId: string; ruling: string }>;
          const results: Array<{ claimId: string; ok: boolean; error?: string }> = [];
          for (const r of rulings) {
            const cid = String(r.claimId ?? "");
            const ruling = String(r.ruling ?? "");
            if (!store.getClaim(cid)) { results.push({ claimId: cid, ok: false, error: "unknown claim" }); continue; }
            if (ruling === "skip") { store.skipNomination(cid); results.push({ claimId: cid, ok: true }); continue; }
            if (ruling !== "true" && ruling !== "false") { results.push({ claimId: cid, ok: false, error: "ruling must be true|false|skip" }); continue; }
            try { store.applyAdjudication(cid, ruling === "true"); results.push({ claimId: cid, ok: true }); }
            catch (e) { results.push({ claimId: cid, ok: false, error: String(e instanceof Error ? e.message : e) }); }
          }
          optimizeState.trainingExamples = store.trainingExampleCount();
          _broadcast();
          return json(res, { batch: true, results });
        }
        // Single mode
        const claimId = String(body["claimId"] ?? "");
        const ruling = String(body["ruling"] ?? "");
        if (!store.getClaim(claimId)) return json(res, { error: `unknown claim: ${claimId}` }, 400);
        if (ruling === "skip") {
          store.skipNomination(claimId);
          return json(res, { ok: true, skipped: claimId });
        }
        if (ruling !== "true" && ruling !== "false") return json(res, { error: "ruling must be true|false|skip" }, 400);
        store.applyAdjudication(claimId, ruling === "true");
        optimizeState.trainingExamples = store.trainingExampleCount();
        _broadcast();
        return json(res, { ok: true, claimId, outcome: ruling });
      }

      if (u === "/api/session" && method === "POST") {
        if (session.running) return json(res, { error: "a session is already running" }, 409);
        if (optimize.running) return json(res, { error: "optimization in progress — wait for it to finish" }, 409);
        const body = await readBody(req);
        const topic = String(body["topic"] ?? "").trim();
        if (!topic) return json(res, { error: "topic required" }, 400);
        const count = Math.min(5, Math.max(1, Number(body["traders"] ?? 3)));
        const maxIterations = Math.min(20, Math.max(1, Number(body["maxIterations"] ?? 8)));

        let setup: ReturnType<TraderFactory>;
        try { setup = traderFactory(count); }
        catch (err) { return json(res, { error: String(err instanceof Error ? err.message : err) }, 400); }

        session.start(runSession({
          store, topic,
          traders: setup.traders,
          leafEvaluator: setup.leafEvaluator,
          llm: setup.llm,
          maxIterations, maxDepth: 1, maxSubAgentCalls: 3,
          sandboxTimeoutMs: 30_000, stallIterations: 10,
          recall: llmSearch(setup.llm),
        } as never), (result, error) => {
          if (result) session.error = result.failures.map(f => `${f.agentId}: ${f.error}`).join("; ") || null;
        });

        return json(res, { started: true, traders: setup.traders.map(t => t.agentId) });
      }

      if (u === "/api/session" && method === "GET") {
        return json(res, {
          running: session.running,
          error: session.error,
          lastRuns: session.last?.runs.map(r => ({ agentId: r.agentId, iterations: r.iterations.length, final: r.final })) ?? [],
        });
      }

      if (u === "/api/optimize" && method === "POST") {
        if (session.running) return json(res, { error: "session in progress — wait for it to finish" }, 409);
        if (optimize.running) return json(res, { error: "optimization already running" }, 409);
        // Precheck: only for the default (production) runner. Injected runners are test seams.
        if (!cfg.gepaRunner && store.trainingExampleCount() < MIN_EXAMPLES) {
          return json(res, { error: `need ${MIN_EXAMPLES} adjudicated examples, have ${store.trainingExampleCount()}` }, 400);
        }

        const started = optimize.start(Promise.resolve().then(() => gepaRunner()));
        return json(res, { started });
      }

      if (u === "/api/optimize" && method === "GET") {
        return json(res, {
          running: optimize.running,
          error: optimize.error,
          last: optimize.last,
          history: store.listOptimizations(),
          trainingExamples: optimizeState.trainingExamples,
          minExamples: MIN_EXAMPLES,
        });
      }

      // Riff compiler
      if (u === "/api/riff" && method === "POST") {
        const body = await readBody(req);
        if (parseFail(body)) return json(res, { error: "invalid JSON" }, 400);
        const text = String(body["text"] ?? "").trim();
        if (!text) return json(res, { error: "riff text required" }, 400);
        const providers = buildProviders();
        if (providers.length === 0) return json(res, { error: "no API keys" }, 400);
        const interpretations = await compileRiff(store, text, providers[0].llm);
        _broadcast();
        return json(res, { interpretations });
      }

      if (u === "/api/riff/confirm" && method === "POST") {
        const body = await readBody(req);
        if (parseFail(body)) return json(res, { error: "invalid JSON" }, 400);
        const confirmed = (body["confirmed"] as Array<{ id: number; accepted: boolean; confidenceOverride?: number }>) ?? [];
        const results = confirmInterpretations(store, confirmed);
        _broadcast();
        return json(res, { results });
      }

      if (u === "/api/riff" && method === "GET") {
        const rows = store.db.prepare("SELECT * FROM interpretations WHERE status='pending' ORDER BY id DESC LIMIT 20").all() as Array<Record<string, unknown>>;
        return json(res, { interpretations: rows.map(r => ({ id: r.id, claimId: r.claim_id, kind: r.kind, confidence: r.confidence, reason: r.reason, quote: r.quote, text: r.reason, status: r.status })) });
      }

      // Cascade: refine now
      if (u === "/api/refine" && method === "POST") {
        const providers = buildProviders();
        if (providers.length === 0) return json(res, { error: "no API keys" }, 400);
        const budget = new BudgetGuard(store);
        const items = scanSources(store);
        if (items.length === 0) return json(res, { message: "no new sources to process" });
        const result = await tier1Decompose(store, items, providers[0].llm, budget);
        _broadcast();
        return json(res, { ...result, sourcesScanned: items.length });
      }

      if (u === "/api/self-improve" && method === "POST") {
        try {
          const result = await selfImprove(store);
          return json(res, result);
        } catch (err) {
          return json(res, { error: String(err instanceof Error ? err.message : err) }, 500);
        }
      }

      if (u === "/api/seed" && method === "POST") {
        store.ensureAgent("seed");
        const ideas = [
          { title: "TypeScript Static Types Reduce Bugs", claims: ["Static typing catches 15% of production bugs", "TypeScript type system is sound for practical use"] },
          { title: "Python is Faster for Prototyping", claims: ["Python development is 2x faster for MVPs", "Dynamic typing enables rapid iteration"] },
        ];
        const created: string[] = [];
        for (const idea of ideas) {
          const r = store.propose({ ...idea, summary: "", body: "", author: "seed" });
          for (const cid of r.claimIds) {
            store.addEvidence({ claimId: cid, excerpt: "Empirical study (2024): type-checked codebases have fewer runtime errors", stance: "supporting", submittedBy: "seed" });
            store.addEvidence({ claimId: cid, excerpt: "Counter: type overhead slows initial development", stance: "counter", submittedBy: "seed" });
            store.placeOrder({ claimId: cid, agentId: "seed", side: "yes", shares: 100 });
          }
          created.push(r.ideaId);
        }
        _broadcast();
        return json(res, { seeded: created.length, ideaIds: created });
      }

      if (method === "GET") {
        const rel = u === "/" ? "index.html" : u.slice(1);
        const full = normalize(join(PUBLIC_DIR, rel));
        if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(404); return void res.end("not found"); }
        try {
          const data = await readFile(full);
          res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
          return void res.end(data);
        } catch {
          res.writeHead(404); return void res.end("not found");
        }
      }

      res.writeHead(404); res.end("not found");
    } catch (err) {
      json(res, { error: String(err instanceof Error ? err.message : err) }, 500);
    }
  }

  const wss = new WebSocketServer({ server, path: "/ws" });
  let lastSent = "";
  _broadcast = () => {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(snapshot(store, session, optimizeState));
    if (payload === lastSent) return;
    lastSent = payload;
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
  };
  wss.on("connection", ws => {
    ws.send(JSON.stringify(snapshot(store, session, optimizeState)));
  });
  const ticker = setInterval(_broadcast, cfg.broadcastMs ?? 1000);

  await new Promise<void>(resolve => server.listen(cfg.port, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;

  return {
    port, server,
    close: () => new Promise<void>((resolve) => {
      clearInterval(ticker);
      wss.close();
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
    }),
  };
}
