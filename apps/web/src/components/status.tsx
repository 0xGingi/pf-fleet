import type { JobResult, LaneState } from "@pf-fleet/protocol";
import type { NodeView } from "@pf-fleet/protocol/api";
import { Badge, type Tone } from "./ui/badge";

const LANE: Record<LaneState, [Tone, string]> = {
  working: ["good", "working"],
  idle: ["info", "idle"],
  starting: ["neutral", "starting"],
  draining: ["warning", "draining"],
  backoff: ["serious", "restarting"],
  error: ["critical", "error"],
  stopped: ["neutral", "stopped"],
};

export function LaneStateBadge({ state }: { state: LaneState | "offline" | "disabled" }) {
  if (state === "offline") return <Badge tone="neutral">offline</Badge>;
  if (state === "disabled") return <Badge tone="neutral">disabled</Badge>;
  const [tone, label] = LANE[state];
  return (
    <Badge tone={tone} pulse={state === "working"}>
      {label}
    </Badge>
  );
}

export const RESULT: Record<JobResult, { tone: Tone; label: string; color: string }> = {
  listed: { tone: "good", label: "listed", color: "var(--good)" },
  already_listed: { tone: "info", label: "already listed", color: "var(--series-1)" },
  refused: { tone: "serious", label: "refused", color: "var(--serious)" },
  error: { tone: "critical", label: "error", color: "var(--critical)" },
  aborted: { tone: "neutral", label: "aborted", color: "var(--neutral)" },
};

export function JobResultBadge({ result }: { result: JobResult | null }) {
  if (!result)
    return (
      <Badge tone="good" pulse>
        running
      </Badge>
    );
  return <Badge tone={RESULT[result].tone}>{RESULT[result].label}</Badge>;
}

/** Agent update state: installing a staged version, or older than the dashboard's. Nothing when current. */
export function AgentUpdateBadge({ node, long }: { node: NodeView; long?: boolean }) {
  if (node.live.updatePending) {
    return <Badge tone="info">{long ? `installing agent ${node.live.updatePending} after current jobs` : `installing ${node.live.updatePending}`}</Badge>;
  }
  if (node.outdated) return <Badge tone="warning">{long ? `agent ${node.agentVersion}: update available` : "agent update"}</Badge>;
  return null;
}

export function NodeStatusBadge({ node }: { node: NodeView }) {
  if (node.live.connected) return <Badge tone="good">online</Badge>;
  if (!node.lastSeenAt) return <Badge tone="warning">not installed</Badge>;
  return <Badge tone="critical">offline</Badge>;
}
