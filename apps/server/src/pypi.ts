/**
 * Follows the newest pirateface on PyPI. Lanes are pinned to it (config.pirateVersion), so a
 * release reaches every worker: agents restart lanes after their current job when it changes.
 */
import type { Hub } from "./hub";

const PYPI = "https://pypi.org/pypi/pirateface/json";
export const PYPI_CHECK_MS = 30 * 60_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Checks PyPI; on a new version stores it and pushes it to every node. Returns the version. */
export async function checkPirateface(hub: Hub, fetchFn: Fetch = fetch, now = Date.now): Promise<string> {
  try {
    const res = await fetchFn(PYPI, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`PyPI answered ${res.status}`);
    const version = ((await res.json()) as { info?: { version?: string } }).info?.version;
    if (!version || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new Error("PyPI returned no usable version");
    const previous = hub.getSetting<string | null>("pirateVersion", null);
    hub.setSetting("pirateCheckedAt", now());
    hub.setSetting("pirateCheckError", null);
    if (version !== previous) {
      hub.setSetting("pirateVersion", version);
      console.log(`pf-fleet: pirateface ${version} is out${previous ? ` (was ${previous})` : ""}`);
      if (hub.followPirateface()) await hub.sendConfigAll();
    }
    return version;
  } catch (e) {
    const message = (e as Error).message;
    hub.setSetting("pirateCheckError", message);
    throw e;
  }
}

export function watchPirateface(hub: Hub): () => void {
  const run = () => checkPirateface(hub).catch((e) => console.warn(`pf-fleet: pirateface check failed: ${(e as Error).message}`));
  void run();
  const timer = setInterval(run, PYPI_CHECK_MS);
  return () => clearInterval(timer);
}
