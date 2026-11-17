/** Semver-style ordering: numeric core, then pre-release ("1.0.0-edge.9" < "1.0.0-edge.10" < "1.0.0"). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre = ""] = v.replace(/^v/, "").split(/-(.*)/s, 2);
    return { core: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length); // a release beats any pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq) return Math.sign(Number(p) - Number(q));
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const olderThan = (a: string, b: string) => compareVersions(a, b) < 0;
