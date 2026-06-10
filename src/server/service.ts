import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../store/store.js";
import { buildAdjudicationCards } from "./cards.js";
import { runSession, type SessionResult } from "../engine/harness.js";
import type { CodeGenerator, LeafEvaluator } from "../engine/agent.js";
import { buildProviders, makeCodeGenerator, makeLeafEvaluator, makeLlm } from "../engine/codegen.js";

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
}

export interface Service {
  port: number;
  server: Server;
  close(): Promise<void>;
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
  if (providers.length === 0) throw new Error("no provider API keys set");
  const traders: TraderSetup[] = Array.from({ length: count }, (_, i) => {
    const p = providers[i % providers.length];
    return {
      agentId: `${p.name}-${PERSONAS[i % PERSONAS.length].split(";")[0].replace(/\s+/g, "-")}`,
      persona: PERSONAS[i % PERSONAS.length],
      codegen: makeCodeGenerator(p.llm),
    };
  });
  return { traders, leafEvaluator: makeLeafEvaluator(providers[0].llm), llm: makeLlm(providers[0].llm) };
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

interface SessionState { running: boolean; error: string | null; last: SessionResult | null }

function snapshot(store: Store, session: SessionState) {
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
    session: { running: session.running, error: session.error },
  };
}

export async function startService(cfg: ServiceConfig): Promise<Service> {
  const { store } = cfg;
  const traderFactory = cfg.traderFactory ?? defaultTraderFactory;
  const session: SessionState = { running: false, error: null, last: null };

  const server = createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const method = req.method ?? "GET";

    try {
      if (u === "/api/state" && method === "GET") return json(res, snapshot(store, session));
      if (u === "/api/queue" && method === "GET") return json(res, { cards: buildAdjudicationCards(store) });

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
        broadcast();
        return json(res, { ok: true, claimId, outcome: ruling });
      }

      if (u === "/api/session" && method === "POST") {
        if (session.running) return json(res, { error: "a session is already running" }, 409);
        const body = await readBody(req);
        const topic = String(body["topic"] ?? "").trim();
        if (!topic) return json(res, { error: "topic required" }, 400);
        const count = Math.min(5, Math.max(1, Number(body["traders"] ?? 3)));
        const maxIterations = Math.min(20, Math.max(1, Number(body["maxIterations"] ?? 8)));

        let setup: ReturnType<TraderFactory>;
        try { setup = traderFactory(count); }
        catch (err) { return json(res, { error: String(err instanceof Error ? err.message : err) }, 400); }

        session.running = true;
        session.error = null;
        void runSession({
          store,
          topic,
          traders: setup.traders,
          leafEvaluator: setup.leafEvaluator,
          llm: setup.llm,
          maxIterations,
          maxDepth: 1,
          maxSubAgentCalls: 3,
          sandboxTimeoutMs: 30_000,
          stallIterations: 10,
        }).then(result => {
          session.last = result;
          session.error = result.failures.map(f => `${f.agentId}: ${f.error}`).join("; ") || null;
        }).catch(err => {
          session.error = String(err instanceof Error ? err.message : err);
        }).finally(() => {
          session.running = false;
          broadcast();
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

      // Static files. Default "/" -> index.html. Reject anything that escapes PUBLIC_DIR.
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

  // WebSocket: push snapshots while clients are connected and state changes.
  const wss = new WebSocketServer({ server, path: "/ws" });
  let lastSent = "";
  function broadcast(): void {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(snapshot(store, session));
    if (payload === lastSent) return;
    lastSent = payload;
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
  }
  wss.on("connection", ws => {
    ws.send(JSON.stringify(snapshot(store, session)));
  });
  const ticker = setInterval(broadcast, cfg.broadcastMs ?? 1000);

  await new Promise<void>(resolve => server.listen(cfg.port, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;

  return {
    port,
    server,
    close: () => new Promise<void>((resolve) => {
      clearInterval(ticker);
      wss.close();
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
    }),
  };
}
