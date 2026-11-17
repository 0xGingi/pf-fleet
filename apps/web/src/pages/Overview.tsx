import { Coins, Gauge, Layers, PackageCheck, Server } from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "@/components/AppShell";
import { DailyChart } from "@/components/DailyChart";
import { EventList } from "@/components/EventList";
import { JobsTable } from "@/components/JobsTable";
import { LaneProgress } from "@/components/LaneProgress";
import { StatTile } from "@/components/StatTile";
import { ThroughputChart } from "@/components/ThroughputChart";
import { Card, CardHeader } from "@/components/ui/card";
import { bytes, rate } from "@/lib/format";
import { useEvents, useJobs, useNodes, useSummary } from "@/lib/queries";

export function Overview() {
  const { data: s } = useSummary();
  const { data: nodes = [] } = useNodes();
  const { data: recent } = useJobs({ limit: 8 });
  const { data: events = [] } = useEvents(undefined, 12);
  const working = nodes.flatMap((n) =>
    n.live.lanes.filter((l) => l.job).map((l) => ({ node: n, lane: l, config: n.lanes.find((c) => c.name === l.name) ?? { name: l.name, enabled: true, drain: false } })),
  );

  return (
    <>
      <PageHeader title="Overview" description="Your Pirate Face workers across every machine" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile icon={Server} label="Nodes online" value={s ? `${s.nodesOnline} / ${s.nodesTotal}` : "—"} sub={s?.lanesTrouble ? `${s.lanesTrouble} lane(s) need attention` : "all lanes healthy"} />
        <StatTile icon={Layers} label="Lanes working" value={s ? `${s.lanesWorking} / ${s.lanesEnabled}` : "—"} sub={s ? `${s.lanesIdle} idle` : undefined} />
        <StatTile icon={Gauge} label="Verifying now" value={s ? rate(s.rateBps) : "—"} sub="across all lanes" />
        <StatTile icon={PackageCheck} label="Listed, last 24h" value={s ? s.last24h.listed : "—"} sub={s ? `${bytes(s.last24h.listedBytes)} · ${s.last24h.refused + s.last24h.error} failed` : undefined} />
        <StatTile icon={Coins} label="Points (estimate)" value={s ? s.pointsEstimate.toLocaleString() : "—"} sub={s ? `${bytes(s.allTime.listedBytes)} listed all time` : undefined} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ThroughputChart />
        </div>
        <Card>
          <CardHeader title="Working now" description={`${working.length} model(s) being verified`} />
          <div className="divide-y divide-border">
            {working.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-text-3">No lane is working on a model right now.</p>
            ) : (
              working.map(({ node, lane, config }) => (
                <Link key={`${node.id}/${lane.name}`} to={`/nodes/${node.id}`} className="block px-5 py-3 hover:bg-surface-2/50">
                  <div className="mb-1 text-xs text-text-3">{node.name}</div>
                  <LaneProgress config={config} status={lane} online={node.live.connected} compact />
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <DailyChart />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Recent jobs"
            actions={
              <Link to="/jobs" className="text-xs text-text-3 hover:text-text hover:underline">
                All jobs
              </Link>
            }
          />
          <JobsTable rows={recent?.rows ?? []} />
        </Card>
        <Card>
          <CardHeader title="Recent events" description="Across all nodes" />
          <div className="max-h-[28rem] overflow-y-auto">
            <EventList events={events} showNode empty="No events yet." />
          </div>
        </Card>
      </div>
    </>
  );
}
