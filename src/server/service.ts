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
import { computeMetrics } from "./metrics.js";
import { makeCliCodeGenerator } from "../engine/cli-provider.js";

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

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
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

  return {
    summary: store.counters(),
    agents: store.listAgents(),
    ideas: store.listIdeas().map(i => ({
      id: i.id,
      title: i.title,
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
        }), (result, error) => {
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
