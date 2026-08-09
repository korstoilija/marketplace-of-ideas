import { defineConfig } from "vitest/config";

// extracted/ holds a standalone library with its own suite — run it from that directory.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "extracted/**"] },
});
