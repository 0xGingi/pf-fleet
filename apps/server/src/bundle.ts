/** The agent binaries this dashboard image ships (AGENT_DIR), with checksums for self-update. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "./crypto";

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
