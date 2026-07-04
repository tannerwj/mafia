export function nextRandom(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  let z = t;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return { value: ((z ^ (z >>> 14)) >>> 0) / 4294967296, state: t };
}

export function shuffle<T>(items: T[], seed: number): { items: T[]; rngState: number } {
  const out = [...items];
  let rngState = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    const next = nextRandom(rngState);
    rngState = next.state;
    const j = Math.floor(next.value * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return { items: out, rngState };
}
