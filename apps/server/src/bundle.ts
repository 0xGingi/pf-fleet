/** The agent binaries this dashboard image ships (AGENT_DIR), with checksums for self-update. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "./crypto";
import { olderThan } from "./versions";

export const ARCHES = ["x86_64", "aarch64"] as const;
export type Arch = (typeof ARCHES)[number];

export interface AgentBinary {
  arch: Arch;
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface AgentBundle {
  version: string | null;
  binaries: Partial<Record<Arch, AgentBinary>>;
}

/**
 * Whether an agent should get this bundle's agent: it is older, or it claims the same version
 * but is a different build (a local or dev build that reused a release number).
 */
export function agentOutdated(bundle: AgentBundle, agent: { version: string | null; sha256: string | null; arch: string | null }): boolean {
  if (!agent.version || !bundle.version) return false;
  if (olderThan(agent.version, bundle.version)) return true;
  const bin = bundle.binaries[agent.arch as Arch];
  return agent.version === bundle.version && !!agent.sha256 && !!bin && agent.sha256 !== bin.sha256;
}

export function loadBundle(dir: string): AgentBundle {
  let version: string | null = null;
  try {
    version = readFileSync(join(dir, "VERSION"), "utf8").trim() || null;
  } catch {
    // no build here (development); install and update are unavailable
  }
  const binaries: AgentBundle["binaries"] = {};
  for (const arch of ARCHES) {
    const path = join(dir, `pf-fleet-agent-${arch}`);
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    binaries[arch] = { arch, path, bytes, sha256: sha256Bytes(bytes) };
  }
  return { version, binaries };
}
