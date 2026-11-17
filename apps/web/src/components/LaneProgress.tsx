import type { LaneConfig, LaneStatus } from "@pf-fleet/protocol";
import { bytes, eta, percent, rate } from "@/lib/format";
import { LaneStateBadge } from "./status";
import { Progress } from "./ui/progress";

/** One lane at a glance: state, and the model it is verifying with progress and speed. */
export function LaneProgress({ config, status, online, compact }: { config: LaneConfig; status?: LaneStatus; online: boolean; compact?: boolean }) {
  const state = laneState(config, status, online);
  const job = status?.job;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium">{config.name}</span>
          <LaneStateBadge state={state} />
        </div>
        {job && <span className="text-xs whitespace-nowrap text-text-3">{rate(job.rateBps)}</span>}
      </div>
      {job ? (
        <>
          <div className="truncate text-xs text-text-2" title={job.repo}>
            {job.repo}
          </div>
          <Progress value={percent(job.doneBytes, job.sizeBytes)} label={`${config.name} progress`} />
          {!compact && (
            <div className="flex justify-between text-xs text-text-3">
              <span>
                {bytes(job.doneBytes)} of {bytes(job.sizeBytes)} · {job.files} files
              </span>
              <span>ETA {eta(job.doneBytes, job.sizeBytes, job.rateBps)}</span>
            </div>
          )}
        </>
      ) : (
        status?.message && (
          <p className="truncate text-xs text-text-3" title={status.message}>
            {status.message}
          </p>
        )
      )}
    </div>
  );
}

type ShownState = Parameters<typeof LaneStateBadge>[0]["state"];

function laneState(config: LaneConfig, status: LaneStatus | undefined, online: boolean): ShownState {
  if (!online) return "offline";
  if (status) return status.state;
  return config.enabled ? "starting" : "disabled";
}
