import { Store } from "./store/store.js";
import { startService } from "./server/service.js";

const PORT = Number(process.env["MP_PORT"] ?? 4280);
const DB = process.env["MP_DB"] ?? "data/marketplace.sqlite";

const store = new Store(DB);
const svc = await startService({ store, port: PORT });

// Global unhandled rejection handler — sandbox errors must never crash the process
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION (surviving):", String(reason instanceof Error ? reason.message : reason).slice(0, 200));
});

console.error(`Marketplace of Ideas — resident at http://127.0.0.1:${svc.port}`);
console.error(`DB: ${DB}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void svc.close().then(() => { store.close(); process.exit(0); });
  });
}
