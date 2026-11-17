import type { SettingsView } from "@pf-fleet/protocol/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { AgentUpdateBadge, NodeStatusBadge } from "@/components/status";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { ApiError, patch } from "@/lib/api";
import { keys, useNodes, useSettings } from "@/lib/queries";

export function Settings() {
  const { data: s } = useSettings();
  const { data: nodes = [] } = useNodes();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: Partial<SettingsView>) => patch<SettingsView>("/api/settings", b),
    onSuccess: (v) => {
      qc.setQueryData(keys.settings, v);
      toast.success(v.autoUpdateAgents ? "Agents update themselves; outdated ones were sent the new agent" : "Automatic agent updates are off");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "could not save"),
  });
  if (!s) return null;

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Versions" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-text-3">Dashboard</dt>
              <dd className="font-mono">{s.dashboardVersion}</dd>
              <dt className="text-text-3">Agent it ships</dt>
              <dd className="font-mono">{s.agentVersion ?? "none (development build)"}</dd>
              <dt className="text-text-3">Agent CPUs</dt>
              <dd className="font-mono">{s.agentArches.join(", ") || "—"}</dd>
            </dl>
            <p className="mt-4 text-xs text-text-3">
              Update the dashboard with <code className="font-mono">docker compose pull && docker compose up -d</code>. It brings the matching agent, which
              then reaches your nodes as set below.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Agent updates" />
          <CardBody className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Update agents automatically</p>
                <p className="mt-0.5 text-xs text-text-3">
                  When a node connects with an older agent, send it this dashboard's agent. It installs after every lane finishes its current job, so no work is
                  lost.
                </p>
              </div>
              <Switch checked={s.autoUpdateAgents} label="Update agents automatically" disabled={save.isPending} onChange={(v) => save.mutate({ autoUpdateAgents: v })} />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Agents" description="The agent version on each node" />
        <Table>
          <thead>
            <tr>
              <Th className="pl-5">Node</Th>
              <Th>Status</Th>
              <Th>Agent</Th>
              <Th>CPU</Th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <Tr key={n.id}>
                <Td>
                  <Link to={`/nodes/${n.id}`} className="font-medium hover:underline">
                    {n.name}
                  </Link>
                </Td>
                <Td>
                  <NodeStatusBadge node={n} />
                </Td>
                <Td className="font-mono text-xs">
                  <span className="mr-2">{n.agentVersion ?? "—"}</span>
                  <AgentUpdateBadge node={n} />
                </Td>
                <Td className="text-text-2">{n.arch ?? "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
