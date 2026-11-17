import type { EventLevel } from "@pf-fleet/protocol";
import type { EventView } from "@pf-fleet/protocol/api";
import { Link } from "react-router";
import { dateTime } from "@/lib/format";
import { Badge, type Tone } from "./ui/badge";

const TONE: Record<EventLevel, Tone> = { info: "info", warn: "warning", error: "critical" };

export function EventList({ events, showNode = false, empty = "Nothing has happened yet." }: { events: EventView[]; showNode?: boolean; empty?: string }) {
  if (!events.length) return <p className="px-5 py-8 text-center text-sm text-text-3">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 px-5 py-2.5 text-sm">
          <Badge tone={TONE[e.level]} className="mt-0.5 shrink-0">
            {e.level}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="break-words text-text-2">
              {showNode && (
                <Link to={`/nodes/${e.nodeId}`} className="mr-1.5 font-medium text-text hover:underline">
                  {e.nodeName ?? "deleted node"}
                </Link>
              )}
              {e.text}
            </p>
            <p className="mt-0.5 text-xs text-text-3">
              {dateTime(e.ts)} · {e.source === "agent" ? "reported by the agent" : "seen by the dashboard"}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
