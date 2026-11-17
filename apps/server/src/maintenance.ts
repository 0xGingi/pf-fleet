/** Hourly cleanup: history older than the retention setting, logs beyond the per-lane cap, old sessions. */
import { lt, sql } from "drizzle-orm";
import { type Db, schema } from "./db";
import type { Hub } from "./hub";

export const DEFAULT_RETENTION_DAYS = 180;
export const LOGS_PER_LANE = 1000;

export function prune(db: Db, hub: Hub, now = Date.now()): void {
  const days = hub.getSetting("retentionDays", DEFAULT_RETENTION_DAYS);
  const cutoff = now - days * 86_400_000;
  const { jobs, samples, events, logs, sessions } = schema;
  db.delete(jobs).where(lt(sql`coalesce(${jobs.finishedAt}, ${jobs.startedAt})`, cutoff)).run();
  db.delete(samples).where(lt(samples.ts, cutoff)).run();
  db.delete(events).where(lt(events.ts, cutoff)).run();
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  db.run(sql`
    delete from ${logs} where ${logs.id} in (
      select id from (
        select id, row_number() over (partition by node_id, lane order by id desc) as rn from ${logs}
      ) where rn > ${LOGS_PER_LANE}
    )`);
}

export function startMaintenance(db: Db, hub: Hub): () => void {
  const run = () => {
    try {
      prune(db, hub);
    } catch (e) {
      console.error("pf-fleet: cleanup failed:", e);
    }
  };
  run();
  const timer = setInterval(run, 3_600_000);
  return () => clearInterval(timer);
}
