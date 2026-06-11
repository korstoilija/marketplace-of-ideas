const $ = (id) => document.getElementById(id);

/** Safe element builder: attributes are set via setAttribute, children that are
 *  strings become text nodes. Untrusted agent content can never become markup. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("data-")) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const histCache = new Map();

function renderQueue(queue) {
  const cards = queue.map(c =>
    el("div", { class: "card" },
      el("div", { class: "claim" }, c.claimText),
      el("div", { class: "meta" },
        `${c.ideaTitle} · yes ${(c.yesPrice * 100).toFixed(0)}% · ${c.orders} orders · ${c.reason}`),
      c.supporting.map(e => el("div", { class: "ev sup" }, e)),
      c.counter.map(e => el("div", { class: "ev cnt" }, e)),
      c.verdicts.slice(0, 2).map(v =>
        el("div", { class: "verdict" }, `${v.agentId} ${(v.confidence * 100).toFixed(0)}%: ${v.reasoning}`)),
      el("div", { class: "actions" },
        el("button", { class: "rule-true", "data-claim": c.claimId, "data-ruling": "true" }, "True"),
        el("button", { class: "rule-false", "data-claim": c.claimId, "data-ruling": "false" }, "False"),
        el("button", { "data-claim": c.claimId, "data-ruling": "skip" }, "Skip"),
      ),
    ));
  $("queue").replaceChildren(...(cards.length ? cards : [el("p", { class: "empty" }, "Nothing needs your judgment yet.")]));
}

function sparkSvg(claimId) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "60");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 60 20");
  svg.dataset.claim = claimId;
  svg.classList.add("spark");
  return svg;
}

function renderMarkets(ideas) {
  const blocks = ideas.flatMap(idea => [
    el("div", { class: "idea-title" }, idea.title),
    ...idea.claims.map(c => {
      const bar = el("div", { class: "pricebar" }, el("i", { style: `width:${(c.yesPrice * 100).toFixed(1)}%` }));
      const left = el("div", {}, c.text, c.resolution ? ` — ${c.resolution.toUpperCase()}` : "", bar);
      const spark = sparkSvg(c.id);
      const row = el("div", { class: `claimrow${c.resolution ? " resolved" : ""}` },
        left,
        el("div", { class: "p" }, `${(c.yesPrice * 100).toFixed(1)}% · ${c.orders} ord`),
        spark,
      );
      void drawSpark(spark);
      return row;
    }),
  ]);
  $("markets").replaceChildren(...(blocks.length ? blocks : [el("p", { class: "empty" }, "No ideas yet. Launch a session.")]));
}

async function drawSpark(svg) {
  const claim = svg.dataset.claim;
  let path = histCache.get(claim);
  if (!path) {
    try { path = (await (await fetch(`/api/history/${encodeURIComponent(claim)}`)).json()).path; }
    catch { return; }
    histCache.set(claim, path);
    setTimeout(() => histCache.delete(claim), 3000);
  }
  if (!path || path.length < 2) return;
  const pts = path.map((p, i) => `${(i / (path.length - 1)) * 58 + 1},${19 - p.yesPrice * 18}`).join(" ");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "1.5");
  svg.replaceChildren(line);
}

function render(s) {
  $("st-ideas").textContent = s.summary.ideas;
  $("st-claims").textContent = s.summary.claims;
  $("st-open").textContent = s.summary.openMarkets;
  $("st-resolved").textContent = s.summary.resolvedMarkets;

  $("launch").disabled = s.session.running;
  $("sessionStatus").textContent = s.session.running
    ? "Session running — agents are writing code and trading…"
    : (s.session.error ? `Last session issues: ${s.session.error}` : "");

  renderQueue(s.queue);
  renderMarkets(s.ideas);

  $("agents").replaceChildren(...s.agents.map(a =>
    el("tr", {},
      el("td", {}, a.agentId),
      el("td", {}, a.balance.toFixed(0)),
      el("td", {}, a.reputation.toFixed(2)),
    )));

  $("feed").replaceChildren(...s.recentOrders.map(o =>
    el("div", {}, `${o.agentId} bought ${o.shares.toFixed(0)} ${o.side.toUpperCase()} on ${o.claimId} (cost ${o.cost.toFixed(1)})`)));

  const need = s.minExamples ?? 30;
  const have = s.trainingExamples ?? 0;
  $("runGepa").disabled = s.optimize.running || have < need;
  $("gepaStatus").textContent = s.optimize.running
    ? "Optimizing evaluator against your rulings…"
    : (s.optimize.error
        ? `Last run: ${s.optimize.error}`
        : (have < need ? `${have}/${need} rulings collected — adjudicate more claims to enable.` : `${have} rulings ready.`));
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-claim]");
  if (!btn) return;
  btn.disabled = true;
  await fetch("/api/adjudicate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimId: btn.dataset.claim, ruling: btn.dataset.ruling }),
  });
  await refresh();
});

$("sessionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: $("topic").value,
      traders: Number($("traders").value),
      maxIterations: Number($("iters").value),
    }),
  });
  const body = await res.json();
  $("sessionStatus").textContent = res.ok
    ? `Started with: ${body.traders.join(", ")}`
    : `Error: ${body.error}`;
});

async function refresh() {
  try { render(await (await fetch("/api/state")).json()); } catch { /* server gone; ws/poll will retry */ }
}

let pollTimer = null;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $("conn").textContent = "live"; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  ws.onmessage = (ev) => { histCache.clear(); render(JSON.parse(ev.data)); };
  ws.onclose = () => {
    $("conn").textContent = "polling";
    if (!pollTimer) pollTimer = setInterval(refresh, 2000);
    setTimeout(connect, 3000);
  };
}
connect();
refresh();

$("runGepa").addEventListener("click", async () => {
  $("runGepa").disabled = true;
  try {
    const res = await fetch("/api/optimize", { method: "POST" });
    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
      $("gepaStatus").textContent = msg;
    }
  } catch (err) {
    $("gepaStatus").textContent = `Network error: ${err.message || err}`;
  }
  await loadGepaHistory();
});

async function loadGepaHistory() {
  try {
    const s = await (await fetch("/api/optimize")).json();
    $("gepaHistory").replaceChildren(...s.history.map(h =>
      el("tr", {},
        el("td", {}, new Date(h.createdAt).toLocaleString()),
        el("td", {}, h.baseline.toFixed(3)),
        el("td", {}, h.optimized.toFixed(3)),
        el("td", {}, String(h.examplesUsed + h.holdoutSize)),
      )));
  } catch { /* server gone */ }
}
loadGepaHistory();
