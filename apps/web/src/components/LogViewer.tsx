import type { LogLine } from "@pf-fleet/protocol";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLogs } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

function lineColor(stream: LogLine["stream"], text: string): string {
  if (stream === "agent") return "text-brand-text";
  if (text.startsWith("error")) return "text-critical";
  return "text-text-2";
}

/** Live tail of one lane's worker output (kept in dashboard memory; last 1000 lines). */
export function LogViewer({ nodeId, lane }: { nodeId: string; lane: string }) {
  const { data = [], isLoading } = useLogs(nodeId, lane);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data, follow]);

  return (
    <div className="relative">
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
        className="h-80 overflow-y-auto bg-surface-2/60 px-4 py-3 font-mono text-xs leading-5"
        role="log"
        aria-live="off"
        aria-label={`${lane} output`}
      >
        {isLoading && <p className="text-text-3">Loading…</p>}
        {!isLoading && data.length === 0 && <p className="text-text-3">No output yet. Lines appear here as the worker prints them.</p>}
        {data.map((l, i) => (
            <div key={i} className="flex gap-3 whitespace-pre-wrap">
              <span className="shrink-0 text-text-3 select-none">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className={cn("min-w-0 break-all", lineColor(l.stream, l.text))}>
                {l.text}
              </span>
            </div>
        ))}
      </div>
      <Button size="sm" variant="secondary" className="absolute right-3 bottom-3 shadow" onClick={() => setFollow((f) => !f)}>
        {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {follow ? "Following" : "Follow"}
      </Button>
    </div>
  );
}
