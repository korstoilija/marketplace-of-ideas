export function hillDiversity(
  p: number[],
  Z: number[][],
  q = 2,
): number {
  if (p.length === 0) return 1;
  const n = p.length;
  const Zp = p.map((_, i) => {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += Z[i][j] * p[j];
    return Math.max(1e-12, sum);
  });

  if (q === 1) {
    let entropy = 0;
    for (let i = 0; i < n; i++) entropy += p[i] * Math.log(Zp[i]);
    return Math.exp(-entropy);
  }

  let sum = 0;
  for (let i = 0; i < n; i++) sum += p[i] * Math.pow(Zp[i], q - 1);
  if (sum <= 0) return 0;
  return Math.pow(sum, 1 / (1 - q));
}

export function identityZ(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

export function onesZ(n: number): number[][] {
  return Array.from({ length: n }, () => Array(n).fill(1));
}

export function buildZ(items: string[], simFn: (a: string, b: string) => number): number[][] {
  return items.map(a => items.map(b => simFn(a, b)));
}

export function marginalDiversity(
  x: string,
  population: string[],
  simFn: (a: string, b: string) => number,
  q = 2,
): number {
  const popWith = [...population, x];
  const ZBefore = buildZ(population, simFn);
  const ZAfter = buildZ(popWith, simFn);
  const pBefore = population.map(() => 1 / population.length);
  const pAfter = popWith.map(() => 1 / popWith.length);
  const dBefore = hillDiversity(pBefore, ZBefore, q);
  const dAfter = hillDiversity(pAfter, ZAfter, q);
  if (dBefore <= 0) return 0;
  return Math.log(dAfter) - Math.log(dBefore);
}

export function diversityProfile(population: string[], simFn: (a: string, b: string) => number) {
  const Z = buildZ(population, simFn);
  const p = population.map(() => 1 / population.length);
  return { q0: hillDiversity(p, Z, 0), q1: hillDiversity(p, Z, 1), q2: hillDiversity(p, Z, 2), qInf: hillDiversity(p, Z, 100) };
}
