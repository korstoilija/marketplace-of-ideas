import { realpathSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, basename, normalize } from "node:path";

const MAX_READ_BYTES = 32_768; // 32KB per read
const MAX_FILE_BYTES = 1_048_576; // 1MB per file
const MAX_FILES = 200;

const DENY_LIST = [
  /\.env(\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /credentials?\.(json|yml|yaml|toml)$/,
  /secret/,
  /\.token$/,
  /private.?key/i,
];

function isDenied(path: string): boolean {
  return DENY_LIST.some(p => p.test(basename(path)));
}

function isBinary(path: string): boolean {
  try {
    const buf = readFileSync(path, { encoding: null });
    const sample = buf.slice(0, 1024);
    return sample.includes(0);
  } catch { return true; }
}

function isDotfile(path: string): boolean {
  const name = basename(path);
  return name.startsWith(".");
}

export interface TargetFile {
  path: string;
  size: number;
}

export interface JailConfig {
  root: string;
  readLimit?: number;
  byteLimit?: number;
}

export class TargetJail {
  readonly root: string;
  private readCount = 0;
  private bytesRead = 0;
  private readLimit: number;
  private byteLimit: number;

  constructor(config: JailConfig) {
    this.root = realpathSync(resolve(config.root));
    if (!existsSync(this.root)) throw new Error(`target not found: ${this.root}`);
    this.readLimit = config.readLimit ?? 100;
    this.byteLimit = config.byteLimit ?? 500_000;
  }

  list(glob?: string): TargetFile[] {
    const results: TargetFile[] = [];
    try {
      this._scan(this.root, "", results, MAX_FILES);
    } catch { /* scan interrupted */ }
    if (glob) {
      const pattern = glob.replace(/\*/g, ".*").replace(/\?/g, ".");
      const re = new RegExp(`^${pattern}$`);
      return results.filter(f => re.test(f.path));
    }
    return results;
  }

  private _scan(dir: string, prefix: string, results: TargetFile[], remaining: number) {
    if (results.length >= remaining) return;
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch { return; }
    for (const name of entries) {
      if (results.length >= remaining) return;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (name === ".git" || name === "node_modules" || name === "dist" || name === "__pycache__") continue;
      if (isDotfile(full)) continue;
      try {
        const st = statSync(full);
        if (st.isDirectory()) { this._scan(full, rel, results, remaining); }
        else if (st.isFile() && st.size <= MAX_FILE_BYTES && !isBinary(full) && !isDenied(full)) {
          results.push({ path: rel, size: st.size });
        }
      } catch { /* stat failed, skip */ }
    }
  }

  read(path: string, offset = 0, maxBytes = MAX_READ_BYTES): string {
    if (this.readCount >= this.readLimit) throw new Error("read budget exhausted");
    if (this.bytesRead >= this.byteLimit) throw new Error("byte budget exhausted");
    if (isDenied(path)) throw new Error(`access denied: ${path}`);

    const resolved = resolve(this.root, path);
    // Jail check: BEFORE realpath, check the resolved path doesn't escape via ..
    if (!resolved.startsWith(this.root + "/") && resolved !== this.root) {
      throw new Error(`jail escape blocked: ${path}`);
    }
    let realPath: string;
    try { realPath = realpathSync(resolved); }
    catch { throw new Error(`path not found: ${path}`); }
    if (!realPath.startsWith(this.root + "/") && realPath !== this.root) {
      throw new Error(`jail escape blocked: ${path} → ${realPath}`);
    }

    maxBytes = Math.min(maxBytes, MAX_READ_BYTES);
    const content = readFileSync(realPath, "utf8");
    const chunk = content.slice(offset, offset + maxBytes);
    this.readCount++;
    this.bytesRead += chunk.length;
    return chunk;
  }

  reset() {
    this.readCount = 0;
    this.bytesRead = 0;
  }
}
