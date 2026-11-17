const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  // whole bytes; more precision for small numbers ("2.5 GB"), at most one decimal for big ones ("120.3 GB")
  let decimals = Math.min(digits, 1);
  if (i === 0) decimals = 0;
  else if (v < 10) decimals = digits;
  return `${v.toFixed(decimals)} ${UNITS[i]}`;
}

export function rate(bps: number | null | undefined): string {
  return bps ? `${bytes(bps)}/s` : "—";
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const d = now - ts;
  if (d < 10_000) return "just now";
  return `${duration(d).split(" ")[0]} ago`;
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0;
}

export function eta(done: number, total: number, bps: number): string {
  if (!bps || total <= done) return "—";
  return duration(((total - done) / bps) * 1000);
}
