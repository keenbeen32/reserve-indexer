// Ported from dtf-index-subgraph/src/utils/arrays.ts.
// AssemblyScript quirks removed; plain TS implementations.

export function removeFromArrayAtIndex<T>(x: readonly T[], index: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i !== index) out.push(x[i]!);
  }
  return out;
}

export function addToArrayAtIndex<T>(x: readonly T[], item: T, index = -1): T[] {
  if (x.length === 0) return [item];
  const at = index === -1 || index > x.length ? x.length : index;
  const out: T[] = [];
  let i = 0;
  while (i < at) {
    out.push(x[i]!);
    i++;
  }
  out.push(item);
  while (i < x.length) {
    out.push(x[i]!);
    i++;
  }
  return out;
}

export function arrayDiff<T>(a: readonly T[], b: readonly T[]): T[] {
  return a.filter((v) => !b.includes(v));
}

export function arrayUnique<T>(array: readonly T[]): T[] {
  return [...new Set(array)];
}

export function arrayUniqueBy<T>(array: readonly T[], pluck: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of array) {
    const k = pluck(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}
