import { createHash } from "node:crypto";

export function embed(text: string, dims = 64): number[] {
  const hash = createHash("sha256").update(text.slice(0, 500)).digest();
  const vec: number[] = [];
  for (let i = 0; i < dims; i++) {
    const byte = hash[i % hash.length];
    vec.push((byte - 128) / 128);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
}

export function similarity(a: string, b: string): number {
  return cosine(embed(a), embed(b));
}
