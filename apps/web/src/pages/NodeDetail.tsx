import type { LaneConfig } from "@pf-fleet/protocol";
import type { CreatedNode, NodeView } from "@pf-fleet/protocol/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpCircle, KeyRound, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { ConfirmButton } from "@/components/Confirm";
import { InstallCommand } from "@/components/InstallCommand";
import { JobsTable } from "@/components/JobsTable";
import { LaneProgress } from "@/components/LaneProgress";
import { LogViewer } from "@/components/LogViewer";
import { AgentUpdateBadge, NodeStatusBadge } from "@/components/status";
import { ThroughputChart } from "@/components/ThroughputChart";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Switch } from "@/components/ui/input";
import { ApiError, del, patch, post } from "@/lib/api";
import { ago, bytes, duration } from "@/lib/format";
import { keys, useAccounts, useJobs, useNode } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LANE_NAME = /^[A-Za-z0-9._-]{1,24}$/;

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : "request failed";
}

export function NodeDetail() {
  const { id = "" } = useParams();
  const { data: node, error } = useNode(id);
  if (error) return <p className="text-sm text-critical">{errorText(error)}</p>;
  if (!node) return null;
  return <NodeDetailView node={node} />;
}

function NodeDetailView({ node }: { node: NodeView }) {
  const qc = useQueryClient();
  const online = node.live.connected;
  const sys = node.live.system;

  const save = useMutation({
    mutationFn: (body: Partial<Pick<NodeView, "name" | "accountId" | "lanes" | "maxSizeGiB" | "idleSec">>) => patch<NodeView>(`/api/nodes/${node.id}`, body),
    onSuccess: (n) => {
      qc.setQueryData(keys.node(node.id), n);
      qc.invalidateQueries({ queryKey: keys.nodes });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const restart = (lane: string | undefined, graceful: boolean) =>
    post(`/api/nodes/${node.id}/restart`, { lane, graceful })
      .then(() => toast.success(graceful ? "Restart queued; it happens after the current job" : "Restarting now"))
      .catch((e) => toast.error(errorText(e)));

  return (
    <>
      <Link to="/nodes" className="mb-3 inline-flex items-center gap-1 text-xs text-text-3 hover:text-text">
        <ArrowLeft className="size-3.5" /> Nodes
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {node.name} <NodeStatusBadge node={node} />
            <AgentUpdateBadge node={node} long />
          </span>
        }
        description={
          node.hostname
            ? [node.hostname, node.os, node.arch, node.cpus && `${node.cpus} CPUs`, node.agentVersion && `agent ${node.agentVersion}`, !online && `last seen ${ago(node.lastSeenAt)}`]
                .filter(Boolean)
                .join(" · ")
            : "Waiting for the agent to connect. Run the install command on the machine."
        }
        actions={
          <>
          {node.outdated && online && !node.live.updatePending && (
            <ConfirmButton
              variant="secondary"
              title="Update the agent?"
              description="The dashboard sends the new agent. It installs once every lane finishes its current job, then the lanes start again on their own."
              confirmLabel="Update after current jobs"
              onConfirm={() =>
                post(`/api/nodes/${node.id}/update-agent`, { graceful: true })
                  .then(() => toast.success("Update sent"))
                  .catch((e) => toast.error(errorText(e)))
              }
            >
              <ArrowUpCircle className="size-3.5" /> Update agent
            </ConfirmButton>
          )}
          <ConfirmButton
            variant="secondary"
            title="Restart all lanes?"
            description="Each lane restarts after its current job, picking up the newest pirateface release."
            confirmLabel="Restart after current jobs"
            onConfirm={() => restart(undefined, true)}
          >
            <RefreshCw className="size-3.5" /> Restart all
          </ConfirmButton>
          </>
        }
      />

      {sys && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Load (1/5/15 min)" value={`${sys.load1.toFixed(2)} / ${sys.load5.toFixed(2)} / ${sys.load15.toFixed(2)}`} />
          <Metric label="Memory used" value={`${bytes(sys.memTotal - sys.memAvailable)} of ${bytes(sys.memTotal)}`} />
          <Metric label="Uptime" value={duration(sys.uptime * 1000)} />
          <Metric label="uv" value={node.live.uvx ? "installed" : "missing"} tone={node.live.uvx ? undefined : "critical"} title={node.live.uvx ?? undefined} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <LanesCard node={node} saving={save.isPending} onLanes={(lanes) => save.mutateAsync({ lanes })} onRestart={restart} />
          <LogsCard node={node} />
        </div>
        <div className="space-y-6">
          <SettingsCard node={node} saving={save.isPending} onSave={(b) => save.mutateAsync(b)} />
          <DangerCard node={node} />
        </div>
      </div>

      <div className="mt-6">
        <ThroughputChart nodeId={node.id} />
      </div>
      <NodeJobs nodeId={node.id} />
    </>
  );
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: "critical"; title?: string }) {
  return (
    <Card className="px-4 py-3" title={title}>
      <div className="text-xs text-text-3">{label}</div>
      <div className={cn("mt-1 truncate text-sm font-medium", tone === "critical" && "text-critical")}>{value}</div>
    </Card>
  );
}

function LanesCard({
  node,
  saving,
  onLanes,
  onRestart,
}: {
  node: NodeView;
  saving: boolean;
  onLanes: (lanes: LaneConfig[]) => Promise<unknown>;
  onRestart: (lane: string | undefined, graceful: boolean) => Promise<unknown>;
}) {
  const [newLane, setNewLane] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);
  const online = node.live.connected;
  const status = (name: string) => node.live.lanes.find((l) => l.name === name);
  const suggest = () => {
    for (let i = 1; ; i++) if (!node.lanes.some((l) => l.name === `${node.name}-${i}`.slice(0, 24))) return `${node.name}-${i}`.slice(0, 24);
  };

  const setEnabled = (name: string, enabled: boolean, drain = false) =>
    onLanes(node.lanes.map((l) => (l.name === name ? { ...l, enabled, drain: !enabled && drain } : l))).catch(() => {});

  const add = () => {
    const name = newLane.trim() || suggest();
    if (!LANE_NAME.test(name)) return toast.error("Lane names are 1-24 letters, digits, '.', '_' or '-'");
    onLanes([...node.lanes, { name, enabled: true, drain: false }])
      .then(() => setNewLane(""))
      .catch(() => {});
  };

  return (
    <Card>
      <CardHeader
        title="Lanes"
        description="Each lane runs one `pf work --name <lane>` worker. Pirate Face allows 3 lanes per account across all nodes."
      />
      <div className="divide-y divide-border">
        {node.lanes.length === 0 && <p className="px-5 py-6 text-sm text-text-3">No lanes yet. Add one below to start working the queue.</p>}
        {node.lanes.map((lane) => {
          const s = status(lane.name);
          const busy = !!s?.job;
          return (
            <div key={lane.name} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <LaneProgress config={lane} status={s} online={online} />
                {s && (s.restarts > 0 || s.pid) && (
                  <p className="mt-1 text-xs text-text-3">
                    {s.pid ? `pid ${s.pid}` : ""}
                    {s.startedAt ? ` · up ${duration(Date.now() - s.startedAt)}` : ""}
                    {s.restarts ? ` · ${s.restarts} restart${s.restarts === 1 ? "" : "s"}` : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={lane.enabled}
                  label={`${lane.name} enabled`}
                  disabled={saving}
                  onChange={(v) => (!v && busy ? setStopping(lane.name) : setEnabled(lane.name, v))}
                />
                <Button size="icon" variant="ghost" title="Restart after the current job" aria-label={`Restart ${lane.name}`} disabled={!online || !lane.enabled} onClick={() => onRestart(lane.name, true)}>
                  <RotateCw className="size-4" />
                </Button>
                {!lane.enabled && (
                  <ConfirmButton
                    variant="ghost"
                    size="icon"
                    title={`Remove ${lane.name}?`}
                    description="The lane is removed from this node. Its job history stays."
                    confirmLabel="Remove lane"
                    onConfirm={() => onLanes(node.lanes.filter((l) => l.name !== lane.name))}
                  >
                    <Trash2 className="size-4" aria-label={`Remove ${lane.name}`} />
                  </ConfirmButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <form
        className="flex gap-2 border-t border-border px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input value={newLane} onChange={(e) => setNewLane(e.target.value)} placeholder={suggest()} aria-label="New lane name" className="max-w-xs font-mono" />
        <Button type="submit" loading={saving}>
          <Plus className="size-4" /> Add lane
        </Button>
      </form>

      <Dialog
        open={!!stopping}
        onOpenChange={(v) => !v && setStopping(null)}
        title={`Stop ${stopping}?`}
        description="It is verifying a model right now."
        footer={
          <>
            <Button
              variant="danger"
              onClick={() => {
                if (stopping) setEnabled(stopping, false, false);
                setStopping(null);
              }}
            >
              Stop now
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (stopping) setEnabled(stopping, false, true);
                setStopping(null);
              }}
            >
              Stop after this job
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-2">Stopping now drops the lease; the model goes back to the queue and the work so far is lost.</p>
      </Dialog>
    </Card>
  );
}

function LogsCard({ node }: { node: NodeView }) {
  const [lane, setLane] = useState(node.lanes[0]?.name ?? "");
  useEffect(() => {
    if (!node.lanes.some((l) => l.name === lane)) setLane(node.lanes[0]?.name ?? "");
  }, [node.lanes, lane]);
  if (!node.lanes.length) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Worker output"
        actions={
          <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Lane">
            {node.lanes.map((l) => (
              <button
                key={l.name}
                type="button"
                role="tab"
                aria-selected={lane === l.name}
                onClick={() => setLane(l.name)}
                className={cn("rounded px-2.5 py-1 font-mono text-xs", lane === l.name ? "bg-surface-2 font-medium text-text" : "text-text-3 hover:text-text")}
              >
                {l.name}
              </button>
            ))}
          </div>
        }
      />
      {lane && <LogViewer key={lane} nodeId={node.id} lane={lane} />}
    </Card>
  );
}

function SettingsCard({ node, saving, onSave }: { node: NodeView; saving: boolean; onSave: (b: Partial<NodeView>) => Promise<unknown> }) {
  const { data: accounts = [] } = useAccounts();
  const [form, setForm] = useState({ name: node.name, accountId: node.accountId ?? "", maxSizeGiB: String(node.maxSizeGiB), idleSec: String(node.idleSec) });
  useEffect(() => {
    setForm({ name: node.name, accountId: node.accountId ?? "", maxSizeGiB: String(node.maxSizeGiB), idleSec: String(node.idleSec) });
  }, [node.name, node.accountId, node.maxSizeGiB, node.idleSec]);
  const dirty =
    form.name !== node.name || form.accountId !== (node.accountId ?? "") || form.maxSizeGiB !== String(node.maxSizeGiB) || form.idleSec !== String(node.idleSec);

  return (
    <Card>
      <CardHeader title="Settings" description="Changing these restarts the lanes after their current jobs." />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              name: form.name.trim(),
              accountId: form.accountId || null,
              maxSizeGiB: Number(form.maxSizeGiB) || 0,
              idleSec: Number(form.idleSec) || 300,
            })
              .then(() => toast.success("Saved"))
              .catch(() => {});
          }}
        >
          <Field label="Name" htmlFor="s-name">
            <Input id="s-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Pirate Face account" htmlFor="s-acct">
            <Select id="s-acct" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">None</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.enabledLanes}/3 lanes)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Largest model (GiB)" htmlFor="s-max" hint="0 takes anything up to the server's cap. Lower it on machines with slow links.">
            <Input id="s-max" type="number" min={0} value={form.maxSizeGiB} onChange={(e) => setForm({ ...form, maxSizeGiB: e.target.value })} />
          </Field>
          <Field label="Idle check interval (seconds)" htmlFor="s-idle" hint="How often an idle lane asks for work.">
            <Input id="s-idle" type="number" min={30} value={form.idleSec} onChange={(e) => setForm({ ...form, idleSec: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
            Save
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function DangerCard({ node }: { node: NodeView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [rotated, setRotated] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Agent access" />
      <CardBody className="space-y-4">
        <div>
          <p className="text-sm">Install command</p>
          <p className="mt-0.5 text-xs text-text-3">Makes a new token and disconnects the agent until you run the new command. Use it for a fresh install or if the token leaked.</p>
          <div className="mt-2">
            <ConfirmButton
              variant="secondary"
              title="Rotate this node's token?"
              description="The running agent is disconnected right away. Its lanes keep working from their last config until you install with the new command."
              confirmLabel="Rotate token"
              onConfirm={() =>
                post<CreatedNode>(`/api/nodes/${node.id}/token`)
                  .then((r) => setRotated(r.installCommand))
                  .catch((e) => toast.error(errorText(e)))
              }
            >
              <KeyRound className="size-3.5" /> New install command
            </ConfirmButton>
          </div>
        </div>
        <div className="border-t border-border pt-4">
          <p className="text-sm">Delete node</p>
          <p className="mt-0.5 text-xs text-text-3">Disconnects the agent and removes the node. Job history stays. Uninstall the agent on the machine yourself.</p>
          <div className="mt-2">
            <ConfirmButton
              title={`Delete ${node.name}?`}
              description="The agent loses access immediately. This cannot be undone."
              confirmLabel="Delete node"
              onConfirm={() =>
                del(`/api/nodes/${node.id}`)
                  .then(() => {
                    qc.invalidateQueries({ queryKey: keys.nodes });
                    navigate("/nodes");
                  })
                  .catch((e) => toast.error(errorText(e)))
              }
            >
              <Trash2 className="size-3.5" /> Delete node
            </ConfirmButton>
          </div>
        </div>
      </CardBody>
      <Dialog open={!!rotated} onOpenChange={(v) => !v && setRotated(null)} title={`New install command for ${node.name}`} className="max-w-2xl">
        {rotated && <InstallCommand command={rotated} />}
      </Dialog>
    </Card>
  );
}

function NodeJobs({ nodeId }: { nodeId: string }) {
  const { data } = useJobs({ nodeId, limit: 15 });
  return (
    <Card className="mt-6">
      <CardHeader
        title="Jobs on this node"
        actions={
          <Link to={`/jobs?nodeId=${nodeId}`} className="text-xs text-text-3 hover:text-text hover:underline">
            All
          </Link>
        }
      />
      <JobsTable rows={data?.rows ?? []} showNode={false} />
    </Card>
  );
}
