import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { Store } from "../src/store/store.js";
import { startService, type Service } from "../src/server/service.js";

let store: Store;
let svc: Service;

beforeEach(async () => {
  store = new Store(":memory:");
  svc = await startService({ store, port: 0 });
});
afterEach(async () => {
  await svc.close();
  store.close();
});

const url = (p: string) => `http://127.0.0.1:${svc.port}${p}`;

describe("service core", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Marketplace of Ideas");
  });

  it("rejects path traversal", async () => {
    const res = await fetch(url("/..%2f..%2fpackage.json"));
    expect(res.status).toBe(404);
  });

  it("GET /api/state returns summary, agents, ideas with prices", async () => {
    store.ensureAgent("alice");
    const { claimIds } = store.propose({ title: "Idea A", summary: "s", body: "", claims: ["c"], author: "alice" });
    store.placeOrder({ claimId: claimIds[0], agentId: "alice", side: "yes", shares: 10 });

    const res = await fetch(url("/api/state"));
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.summary.ideas).toBe(1);
    expect(s.agents[0].agentId).toBe("alice");
    expect(s.ideas[0].title).toBe("Idea A");
    expect(s.ideas[0].claims[0].yesPrice).toBeGreaterThan(0.5);
    expect(s.recentOrders).toHaveLength(1);
  });

  it("GET /api/queue returns adjudication cards", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 250 });
    store.nominate(claimIds[0], "threshold");
    const res = await fetch(url("/api/queue"));
    const q = await res.json();
    expect(q.cards).toHaveLength(1);
    expect(q.cards[0].claimId).toBe(claimIds[0]);
  });

  it("GET /api/history/:claimId returns the price path", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 10 });
    const res = await fetch(url(`/api/history/${claimIds[0]}`));
    const h = await res.json();
    expect(h.path).toHaveLength(2);
    expect(h.path[0].yesPrice).toBeCloseTo(0.5);
  });
});

describe("adjudication flow over HTTP", () => {
  it("a ruling pays out, updates reputation, clears the queue, emits a training example", async () => {
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" });
    const cid = claimIds[0];
    store.addEvidence({ claimId: cid, excerpt: "pro", stance: "supporting", submittedBy: "alice" });
    store.placeOrder({ claimId: cid, agentId: "alice", side: "yes", shares: 40 });
    store.placeOrder({ claimId: cid, agentId: "bob", side: "no", shares: 30 });
    store.nominate(cid, "threshold");
    const aliceBefore = store.getAgent("alice")!.balance;

    const res = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: cid, ruling: "true" }),
    });
    expect(res.status).toBe(200);

    expect(store.getAgent("alice")!.balance).toBeCloseTo(aliceBefore + 40);
    expect(store.getAgent("alice")!.reputation).toBe(1);
    expect(store.getAgent("bob")!.reputation).toBe(0);
    expect(store.pendingNominations()).toHaveLength(0);
    expect(store.listTrainingExamples()).toHaveLength(1);

    const dup = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: cid, ruling: "false" }),
    });
    expect(dup.status).toBe(500); // already resolved -> store throws -> 500 with error body
  });

  it("skip clears the nomination without resolving", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T2", summary: "s", body: "", claims: ["c"], author: "a" });
    store.nominate(claimIds[0], "stalled");
    const res = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: claimIds[0], ruling: "skip" }),
    });
    expect(res.status).toBe(200);
    expect(store.pendingNominations()).toHaveLength(0);
    expect(store.getMarket(claimIds[0])!.resolution).toBeNull();
  });
});

describe("session over HTTP with scripted traders", () => {
  it("launches, runs to completion, and populates the store", async () => {
    await svc.close();
    const scripted = (title: string) => {
      let done = false;
      return async () => {
        if (done) return `Final = { ok: true };`;
        done = true;
        return `
          const { claimIds } = ideas.propose({ title: "${title}", summary: "s", body: "", claims: ["claim"] });
          market.buyYes(claimIds[0], 30);
          print("traded");
        `;
      };
    };
    svc = await startService({
      store, port: 0,
      traderFactory: (count) => ({
        traders: Array.from({ length: count }, (_, i) => ({
          agentId: `scripted-${i}`, persona: "test", codegen: scripted(`Scripted Idea ${i}`),
        })),
        leafEvaluator: async () => ({ confidence: 0.5, reasoning: "test" }),
        llm: async () => "ok",
      }),
    });

    const start = await fetch(url("/api/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "test topic", traders: 2, maxIterations: 4 }),
    });
    expect(start.status).toBe(200);
    expect((await start.json()).traders).toHaveLength(2);

    // poll until the session ends
    for (let i = 0; i < 100; i++) {
      const s = await (await fetch(url("/api/session"))).json();
      if (!s.running) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const s = await (await fetch(url("/api/session"))).json();
    expect(s.running).toBe(false);
    expect(s.lastRuns).toHaveLength(2);
    expect(store.counters().ideas).toBe(2);

    const second = await fetch(url("/api/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "" }),
    });
    expect(second.status).toBe(400); // topic required
  });
});

describe("websocket", () => {
  it("sends a snapshot on connect and pushes after adjudication", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "WS", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 250 });
    store.nominate(claimIds[0], "threshold");

    const ws = new WebSocket(`ws://127.0.0.1:${svc.port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (d: Buffer) => messages.push(JSON.parse(d.toString())));
    await new Promise(r => ws.once("open", r));
    await new Promise(r => setTimeout(r, 100));

    expect(messages).toHaveLength(1); // connect snapshot
    expect((messages[0]["queue"] as unknown[]).length).toBe(1);

    await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: claimIds[0], ruling: "true" }),
    });
    await new Promise(r => setTimeout(r, 200));

    expect(messages.length).toBeGreaterThanOrEqual(2); // pushed update
    const last = messages[messages.length - 1];
    expect((last["queue"] as unknown[]).length).toBe(0);
    ws.close();
  });
});
