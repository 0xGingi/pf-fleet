import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bytes, rate } from "@/lib/format";
import { useThroughput } from "@/lib/queries";
import { cn, SERIES } from "@/lib/utils";
import { Card, CardHeader } from "./ui/card";
import { Table, Td, Th, Tr } from "./ui/table";

const RANGES = [
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 24 * 7, label: "7d" },
  { hours: 24 * 30, label: "30d" },
];

interface Series {
  key: string;
  name: string;
  color: string;
  ids: string[];
}

/** Verified bytes per second, stacked by node. Colour follows the node (creation order), 8 slots, then "Other". */
export function ThroughputChart({ nodeId }: { nodeId?: string }) {
  const [hours, setHours] = useState(24);
  const [asTable, setAsTable] = useState(false);
  const { data, isLoading } = useThroughput(hours);

  const { series, rows } = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const shown = nodeId ? nodes.filter((n) => n.id === nodeId) : nodes;
    const series: Series[] =
      shown.length <= 8
        ? shown.map((n) => ({ key: n.id, name: n.name, color: SERIES[nodes.indexOf(n)] ?? "var(--neutral)", ids: [n.id] }))
        : [
            ...shown.slice(0, 7).map((n, i) => ({ key: n.id, name: n.name, color: SERIES[i]!, ids: [n.id] })),
            { key: "other", name: `Other (${shown.length - 7})`, color: "var(--neutral)", ids: shown.slice(7).map((n) => n.id) },
          ];
    const rows = (data?.points ?? []).map((p) => {
      const row: Record<string, number> = { ts: p.ts };
      for (const s of series) row[s.key] = s.ids.reduce((sum, id) => sum + (p.values[id] ?? 0), 0);
      return row;
    });
    return { series, rows };
  }, [data, nodeId]);

  const bucketSec = (data?.bucketMs ?? 60_000) / 1000;
  const totals = series.map((s) => {
    const vals = rows.map((r) => r[s.key] ?? 0);
    return { ...s, bytes: vals.reduce((a, b) => a + b, 0) * bucketSec, peak: Math.max(0, ...vals) };
  });
  const empty = !isLoading && totals.every((t) => t.bytes === 0);
  const tick = (ts: number) =>
    new Date(ts).toLocaleString(undefined, hours > 48 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });

  return (
    <Card>
      <CardHeader
        title="Verification throughput"
        description="Bytes streamed from Hugging Face and checked, per second"
        actions={
          <>
            <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r.hours}
                  type="button"
                  onClick={() => setHours(r.hours)}
                  aria-pressed={hours === r.hours}
                  className={cn("rounded px-2.5 py-1 text-xs", hours === r.hours ? "bg-surface-2 font-medium text-text" : "text-text-3 hover:text-text")}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="text-xs text-text-3 underline-offset-2 hover:text-text hover:underline" onClick={() => setAsTable((v) => !v)}>
              {asTable ? "Chart" : "Table"}
            </button>
          </>
        }
      />
      {series.length > 1 && !asTable && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pt-4 text-xs text-text-2">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {asTable ? (
        <Table>
          <thead>
            <tr>
              <Th>Node</Th>
              <Th className="text-right">Verified</Th>
              <Th className="text-right">Peak rate</Th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <Tr key={t.key}>
                <Td>{t.name}</Td>
                <Td className="text-right">{bytes(t.bytes)}</Td>
                <Td className="text-right">{rate(t.peak)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="h-64 px-2 pt-2 pb-3">
          {empty ? (
            <p className="py-24 text-center text-sm text-text-3">Nothing verified in this range yet.</p>
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={tick} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(v: number) => rate(v)} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={false} tickLine={false} width={72} />
              <Tooltip
                cursor={{ stroke: "var(--text-3)", strokeWidth: 1 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const total = payload.reduce((s, p) => s + Number(p.value ?? 0), 0);
                  return (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
                      <div className="mb-1 font-medium text-text">{new Date(Number(label)).toLocaleString()}</div>
                      {[...payload].reverse().map((p) => (
                        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-text-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
                            {series.find((s) => s.key === p.dataKey)?.name}
                          </span>
                          <span className="text-text">{rate(Number(p.value))}</span>
                        </div>
                      ))}
                      {payload.length > 1 && (
                        <div className="mt-1 flex justify-between border-t border-border pt-1 text-text">
                          <span>Total</span>
                          <span>{rate(total)}</span>
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              {series.map((s) => (
                <Area key={s.key} type="monotone" dataKey={s.key} stackId="1" stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.22} isAnimationActive={false} activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          )}
        </div>
      )}
    </Card>
  );
}
