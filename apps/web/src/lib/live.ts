import type { LogLine } from "@pf-fleet/protocol";
import type { LiveEvent, NodeView } from "@pf-fleet/protocol/api";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { keys } from "./queries";

const LOG_KEEP = 1000;

export type LiveStatus = "connecting" | "live" | "reconnecting";

/** Debounce helper so a burst of events triggers one refetch. */
function debounced(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function apply(qc: QueryClient, e: LiveEvent, later: { jobs: () => void; summary: () => void }) {
  switch (e.type) {
    case "node": {
      const patchNode = (n: NodeView): NodeView => (n.id === e.nodeId ? { ...n, live: e.live, lastSeenAt: e.live.ts ?? n.lastSeenAt } : n);
      qc.setQueryData<NodeView[]>(keys.nodes, (list) => list?.map(patchNode));
      qc.setQueryData<NodeView>(keys.node(e.nodeId), (n) => (n ? patchNode(n) : n));
      later.summary();
      break;
    }
    case "job":
      later.jobs();
      later.summary();
      break;
    case "log":
      qc.setQueryData<LogLine[]>(keys.logs(e.nodeId, e.lane), (old) => {
        if (!old) return old; // not being viewed; fetched fresh when opened
        const next = old.concat(e.lines);
        return next.length > LOG_KEEP ? next.slice(-LOG_KEEP) : next;
      });
      break;
    case "nodes":
      qc.invalidateQueries({ queryKey: keys.nodes });
      later.summary();
      break;
    case "accounts":
      qc.invalidateQueries({ queryKey: keys.accounts });
      break;
  }
}

/** One EventSource for the whole app; patches the query cache as events arrive. */
export function useLive(enabled: boolean): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const later = useRef({
    jobs: debounced(() => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["daily"] });
    }, 800),
    summary: debounced(() => qc.invalidateQueries({ queryKey: keys.summary }), 3000),
  });

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/api/events", { withCredentials: true });
    const types: LiveEvent["type"][] = ["node", "job", "log", "nodes", "accounts"];
    for (const t of types) es.addEventListener(t, (m) => apply(qc, JSON.parse((m as MessageEvent).data), later.current));
    es.addEventListener("ready", () => {
      setStatus("live");
      // anything missed while disconnected
      qc.invalidateQueries();
    });
    es.onerror = () => setStatus("reconnecting");
    return () => es.close();
  }, [enabled, qc]);

  return status;
}
