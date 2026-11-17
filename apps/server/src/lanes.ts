import { LANE_NAME, LANES_PER_ACCOUNT, type LaneConfig } from "@pf-fleet/protocol";

export interface NodeLanes {
  id: string;
  name: string;
  accountId: string | null;
  lanes: LaneConfig[];
}

/**
 * Pirate Face leases jobs per (account, lane name), and runs at most 3 lanes per account.
 * Returns the first problem with giving `node` these lanes and account, or null.
 */
export function laneProblem(node: NodeLanes, all: NodeLanes[]): string | null {
  const seen = new Set<string>();
  for (const lane of node.lanes) {
    if (!LANE_NAME.test(lane.name)) return `lane "${lane.name}": use 1-24 letters, digits, ".", "_" or "-"`;
    if (seen.has(lane.name)) return `lane "${lane.name}" appears twice on this node`;
    seen.add(lane.name);
  }
  if (!node.accountId) {
    return node.lanes.some((l) => l.enabled) ? "pick an account before enabling lanes" : null;
  }
  const others = all.filter((n) => n.id !== node.id && n.accountId === node.accountId);
  for (const other of others) {
    const clash = other.lanes.find((l) => seen.has(l.name));
    if (clash) return `lane "${clash.name}" is already used on node "${other.name}" with this account; lane names must be unique per account`;
  }
  const enabled = [node, ...others].flatMap((n) => n.lanes.filter((l) => l.enabled).map((l) => `${n.name}/${l.name}`));
  if (enabled.length > LANES_PER_ACCOUNT) {
    return `this account would run ${enabled.length} lanes (${enabled.join(", ")}); Pirate Face allows ${LANES_PER_ACCOUNT} at once`;
  }
  return null;
}
