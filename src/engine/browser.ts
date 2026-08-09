import puppeteer, { type Browser, type Page } from "puppeteer";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
const MIME: Record<string, string> = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", wasm: "application/wasm" };

let _browser: Browser | null = null;
let _server: Server | null = null;
const _serverPort = 4281;

async function ensureBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--enable-webgl",
      "--use-gl=swiftshader",
    ],
  });
  return _browser;
}

function ensureServer(): Server {
  if (_server) return _server;
  _server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${_serverPort}`);
    let path = url.pathname.replace(/^\/+/, "") || "index.html";
    if (path.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }
    const full = resolve(process.cwd(), "workspace", path);
    if (!existsSync(full)) { res.writeHead(404); res.end("not found"); return; }
    try {
      const content = readFileSync(full);
      const ext = path.split(".").pop() || "";
      const mime: Record<string, string> = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[ext] || "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end(content);
    } catch { res.writeHead(500); res.end("read error"); }
  });
  _server.listen(_serverPort);
  return _server;
}

export interface BrowserTestResult {
  url: string;
  errors: string[];
  warnings: string[];
  logs: string[];
  exceptions: string[];
  /** State snapshot after actions — evaluated JS values. */
  state: Record<string, unknown>;
  timeout: boolean;
}

export interface BrowserTestOptions {
  /** Milliseconds to wait after loading + after each action batch. */
  wait: number;
  /** Keydown events to send: "KeyW", "Space", "ArrowUp", etc. */
  actions: string[];
  /** JS expressions to evaluate after actions: { "player.y": "height", "errors.length": "errorCount" } */
  probes: Record<string, string>;
}

export async function browserTest(filePath: string, options: Partial<BrowserTestOptions> = {}): Promise<BrowserTestResult> {
  const b = await ensureBrowser();
  ensureServer();

  const url = `http://localhost:${_serverPort}/${filePath.replace(/^\/+/, "")}`;
  const page = await b.newPage();

  const errors: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const exceptions: string[] = [];

  page.on("console", msg => {
    const t = msg.type();
    const text = msg.text().slice(0, 500);
    if (t === "error") errors.push(text);
    else if (t === "warn") warnings.push(text);
    else logs.push(text);
  });
  page.on("pageerror", err => exceptions.push((err instanceof Error ? err.message : String(err)).slice(0, 500)));

  let timeout = false;
  const state: Record<string, unknown> = {};
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise(r => setTimeout(r, options.wait ?? 3000));

    // Perform actions
    for (const key of options.actions ?? []) {
      await page.keyboard.down(key as any);
    }
    if ((options.actions?.length ?? 0) > 0) {
      await new Promise(r => setTimeout(r, 500));
      for (const key of options.actions ?? []) {
        await page.keyboard.up(key as any);
      }
    }
    await new Promise(r => setTimeout(r, 1000));

    // Evaluate state probes
    for (const [name, expr] of Object.entries(options.probes ?? {})) {
      try {
        state[name] = await page.evaluate(expr);
      } catch { state[name] = "eval-error"; }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout") || msg.includes("Timeout")) timeout = true;
    errors.push("BROWSER: " + msg);
  } finally {
    await page.close().catch(() => {});
  }

  return { url, errors, warnings, logs, exceptions, state, timeout };
}

export async function closeBrowser(): Promise<void> {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
  if (_server) { _server.close(); _server = null; }
}
