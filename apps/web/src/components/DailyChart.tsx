import type { JobResult } from "@pf-fleet/protocol";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bytes } from "@/lib/format";
import { useDaily } from "@/lib/queries";
import { RESULT } from "./status";
import { Card, CardHeader } from "./ui/card";

const ORDER: JobResult[] = ["listed", "already_listed", "refused", "error", "aborted"];

export function DailyChart({ days = 14 }: { days?: number }) {
  const { data = [] } = useDaily(days);
  const empty = data.every((d) => ORDER.every((r) => d[r] === 0));
  return (
    <Card>
      <CardHeader title="Jobs per day" description={`Outcomes over the last ${days} days (UTC)`} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pt-4 text-xs text-text-2">
        {ORDER.map((r) => (
          <span key={r} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: RESULT[r].color }} aria-hidden />
            {RESULT[r].label}
          </span>
        ))}
      </div>
      {empty ? (
        <p className="px-5 py-16 text-center text-sm text-text-3">No finished jobs yet.</p>
      ) : (
        <div className="h-56 px-2 pt-2 pb-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: "var(--text-3)", fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
              <Tooltip
                cursor={{ fill: "var(--surface-2)" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0]!.payload as (typeof data)[number];
                  return (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
                      <div className="mb-1 font-medium text-text">{String(label)}</div>
                      {ORDER.filter((r) => row[r] > 0).map((r) => (
                        <div key={r} className="flex items-center justify-between gap-4 text-text-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-2 rounded-sm" style={{ background: RESULT[r].color }} aria-hidden />
                            {RESULT[r].label}
                          </span>
                          <span className="text-text">{row[r]}</span>
                        </div>
                      ))}
                      {row.listedBytes > 0 && <div className="mt-1 border-t border-border pt-1 text-text-2">{bytes(row.listedBytes)} listed</div>}
                    </div>
                  );
                }}
              />
              {ORDER.map((r, i) => (
                <Bar key={r} dataKey={r} stackId="d" fill={RESULT[r].color} stroke="var(--surface)" strokeWidth={2} radius={i === ORDER.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
