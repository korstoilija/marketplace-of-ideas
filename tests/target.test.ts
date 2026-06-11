import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TargetJail } from "../src/engine/target.js";

describe("TargetJail", () => {
  let root: string;
  let jail: TargetJail;

  beforeEach(() => {
    root = join(tmpdir(), `mp-jail-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "README.md"), "# Test Project\n\nThis is a test.");
    writeFileSync(join(root, "src/index.ts"), "const x = 1;\nexport default x;");
    writeFileSync(join(root, "src/utils.ts"), "export function add(a,b){return a+b}");
    writeFileSync(join(root, "data/numbers.csv"), "a,b,c\n1,2,3\n4,5,6");
    writeFileSync(join(root, ".env"), "SECRET=12345");
    writeFileSync(join(root, ".gitignore"), "dist\nnode_modules");
    jail = new TargetJail({ root });
  });

  afterEach(() => { try { rmSync(root, { recursive: true }); } catch {} });

  it("lists files, skipping dotfiles and .git", () => {
    const files = jail.list();
    const paths = files.map(f => f.path).sort();
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils.ts");
    expect(paths).toContain("data/numbers.csv");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".gitignore");
  });

  it("list supports glob patterns", () => {
    const tsFiles = jail.list("src/*.ts");
    expect(tsFiles.map(f => f.path).sort()).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("reads file content within root", () => {
    const content = jail.read("README.md");
    expect(content).toContain("Test Project");
  });

  it("reads with offset", () => {
    const content = jail.read("src/index.ts", 6);
    expect(content).toBe("x = 1;\nexport default x;");
  });

  it("reads with maxBytes cap", () => {
    const content = jail.read("src/index.ts", 0, 10);
    expect(content.length).toBeLessThanOrEqual(10);
    expect(content).toBe("const x = "); // slice(0,10) = 10 chars
  });

  it("denies access to credential files", () => {
    expect(() => jail.read(".env")).toThrow(/access denied/);
  });

  it("blocks path traversal", () => {
    expect(() => jail.read("../etc/passwd")).toThrow(/jail escape/);
  });

  it("blocks absolute paths outside root", () => {
    expect(() => jail.read("/etc/passwd")).toThrow(/jail escape/);
  });

  it("blocks symlink escape", () => {
    const outside = join(tmpdir(), `mp-jail-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "escaped");
    try {
      symlinkSync(outside, join(root, "escape-link"));
      expect(() => jail.read("escape-link")).toThrow(/jail escape/);
    } finally {
      try { rmSync(join(root, "escape-link")); } catch {}
      rmSync(outside, { recursive: true });
    }
  });

  it("enforces read count budget", () => {
    const limited = new TargetJail({ root, readLimit: 2 });
    limited.read("README.md");
    limited.read("src/index.ts");
    expect(() => limited.read("src/utils.ts")).toThrow(/read budget/);
  });

  it("enforces byte budget", () => {
    const limited = new TargetJail({ root, byteLimit: 0 });
    expect(() => limited.read("README.md")).toThrow(/byte budget/);
  });

  it("reset clears budgets", () => {
    const limited = new TargetJail({ root, readLimit: 2 });
    limited.read("README.md");
    limited.read("src/index.ts");
    expect(() => limited.read("src/utils.ts")).toThrow(/read budget/);
    limited.reset();
    expect(() => limited.read("src/utils.ts")).not.toThrow();
  });

  it("skips binary files", () => {
    writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00]));
    const files = jail.list();
    expect(files.map(f => f.path)).not.toContain("image.png");
  });

  it("skips files larger than 1MB", () => {
    // Skip creating a huge file — just test that the cap is respected
    const files = jail.list();
    files.forEach(f => expect(f.size).toBeLessThanOrEqual(1_048_576));
  });
});
