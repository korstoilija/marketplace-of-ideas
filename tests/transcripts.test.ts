import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("session transcripts", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("createSession/endSession round-trip", () => {
    const id = store.createSession("test topic");
    expect(id).toBeGreaterThan(0);
    store.endSession(id);
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(id);
    expect(sessions[0].topic).toBe("test topic");
    expect(sessions[0].endedAt).toBeGreaterThan(0);
  });

  it("recordAgentIteration persists transcripts in order", () => {
    const sid = store.createSession("order test");
    store.recordAgentIteration({ sessionId: sid, agentId: "alpha", depth: 0, iteration: 0, code: "print(1)", stdout: "1\n", timedOut: false, hasFinal: false });
    store.recordAgentIteration({ sessionId: sid, agentId: "alpha", depth: 0, iteration: 1, code: "Final=1", stdout: "", timedOut: false, hasFinal: true });
    const iters = store.getSessionIterations(sid);
    expect(iters).toHaveLength(2);
    expect(iters[0].code).toBe("print(1)");
    expect(iters[1].code).toBe("Final=1");
    expect(iters[0].hasFinal).toBe(false);
    expect(iters[1].hasFinal).toBe(true);
  });

  it("listSessions reports iteration/agent counts, newest first", () => {
    const s1 = store.createSession("first");
    store.recordAgentIteration({ sessionId: s1, agentId: "a", depth: 0, iteration: 0, code: "x", stdout: "", timedOut: false, hasFinal: false });
    store.recordAgentIteration({ sessionId: s1, agentId: "b", depth: 0, iteration: 0, code: "y", stdout: "", timedOut: false, hasFinal: false });

    const s2 = store.createSession("second");
    store.recordAgentIteration({ sessionId: s2, agentId: "a", depth: 0, iteration: 0, code: "z", stdout: "", timedOut: false, hasFinal: false });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(s2); // newest first
    expect(sessions[1].id).toBe(s1);
    expect(sessions[0].iterations).toBe(1);
    expect(sessions[0].agents).toBe(1);
    expect(sessions[1].iterations).toBe(2);
    expect(sessions[1].agents).toBe(2);
  });

  it("stdout capped at 5000 chars", () => {
    const sid = store.createSession("cap test");
    const big = "x".repeat(6000);
    store.recordAgentIteration({ sessionId: sid, agentId: "a", depth: 0, iteration: 0, code: "c", stdout: big, timedOut: false, hasFinal: false });
    const iters = store.getSessionIterations(sid);
    expect(iters[0].stdout.length).toBeLessThanOrEqual(5000);
  });

  it("code capped at 10000 chars", () => {
    const sid = store.createSession("code cap test");
    const big = "x".repeat(15000);
    store.recordAgentIteration({ sessionId: sid, agentId: "a", depth: 0, iteration: 0, code: big, stdout: "", timedOut: false, hasFinal: false });
    const iters = store.getSessionIterations(sid);
    expect(iters[0].code.length).toBeLessThanOrEqual(10000);
  });

  it("timedOut and hasFinal boolean fields are persisted", () => {
    const sid = store.createSession("bool test");
    store.recordAgentIteration({ sessionId: sid, agentId: "t", depth: 0, iteration: 0, code: "c", stdout: "", timedOut: true, hasFinal: false });
    store.recordAgentIteration({ sessionId: sid, agentId: "t", depth: 0, iteration: 1, code: "c", stdout: "", timedOut: false, hasFinal: true });
    const iters = store.getSessionIterations(sid);
    expect(iters[0].timedOut).toBe(true);
    expect(iters[0].hasFinal).toBe(false);
    expect(iters[1].timedOut).toBe(false);
    expect(iters[1].hasFinal).toBe(true);
  });
});
