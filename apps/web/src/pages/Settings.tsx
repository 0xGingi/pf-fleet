import type { SettingsPatch, SettingsView } from "@pf-fleet/protocol/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { AgentUpdateBadge, NodeStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Switch } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { ApiError, patch, post } from "@/lib/api";
import { ago } from "@/lib/format";
import { keys, useNodes, useSettings } from "@/lib/queries";

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "request failed";
}

function Toggle({ title, description, checked, disabled, onChange }: { title: string; description: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-text-3">{description}</p>
      </div>
      <Switch checked={checked} label={title} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export function Settings() {
  const { data: s } = useSettings();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: SettingsPatch) => patch<SettingsView>("/api/settings", b),
    onSuccess: (v) => qc.setQueryData(keys.settings, v),
    onError: (e) => toast.error(errorText(e)),
  });
  if (!s) return null;
  const set = (b: SettingsPatch, message?: string) => save.mutate(b, { onSuccess: () => message && toast.success(message) });

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <PirateFaceCard s={s} busy={save.isPending} set={set} />
        <AlertsCard s={s} busy={save.isPending} set={set} />
        <Card>
          <CardHeader title="Agent updates" />
          <CardBody className="space-y-4">
            <Toggle
              title="Update agents automatically"
              description="When a node connects with an older agent, send it this dashboard's agent. It installs after every lane finishes its current job, so no work is lost. Only releases go out automatically: on an edge or development build, use Update agent on a node."
              checked={s.autoUpdateAgents}
              disabled={save.isPending}
              onChange={(v) => set({ autoUpdateAgents: v }, v ? "Outdated agents were sent the new agent" : "Automatic agent updates are off")}
            />
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
              <dt className="text-text-3">Dashboard</dt>
              <dd className="font-mono">{s.dashboardVersion}</dd>
              <dt className="text-text-3">Agent it ships</dt>
              <dd className="font-mono">{s.agentVersion ?? "none (development build)"}</dd>
              <dt className="text-text-3">Agent CPUs</dt>
              <dd className="font-mono">{s.agentArches.join(", ") || "—"}</dd>
            </dl>
            <p className="text-xs text-text-3">
              Update the dashboard with <code className="font-mono">docker compose pull && docker compose up -d</code>; its agent then reaches your nodes.
            </p>
          </CardBody>
        </Card>
        <HistoryCard s={s} busy={save.isPending} set={set} />
      </div>
      <AgentsTable />
    </>
  );
}

type CardProps = { s: SettingsView; busy: boolean; set: (b: SettingsPatch, message?: string) => void };

function PirateFaceCard({ s, busy, set }: CardProps) {
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => post<SettingsView>("/api/settings/check-pirateface"),
    onSuccess: (v) => {
      qc.setQueryData(keys.settings, v);
      toast.success(`Newest pirateface: ${v.pirateVersion}`);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Card>
      <CardHeader
        title="pirateface"
        description="The Python package every lane runs"
        actions={
          <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
            Check now
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <Toggle
          title="Follow new releases"
          description="The dashboard checks PyPI every 30 minutes and pins every lane to the newest version. When one comes out, each lane restarts into it after its current job. Off: lanes take whatever is newest when they start."
          checked={s.followPirateface}
          disabled={busy}
          onChange={(v) => set({ followPirateface: v })}
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <dt className="text-text-3">Newest on PyPI</dt>
          <dd className="font-mono">{s.pirateVersion ?? "not checked yet"}</dd>
          <dt className="text-text-3">Checked</dt>
          <dd>{ago(s.pirateCheckedAt)}</dd>
          {s.pirateCheckError && (
            <>
              <dt className="text-text-3">Last check</dt>
              <dd className="text-critical">{s.pirateCheckError}</dd>
            </>
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

function AlertsCard({ s, busy, set }: CardProps) {
  const [url, setUrl] = useState("");
  const test = useMutation({
    mutationFn: () => post("/api/settings/test-alert"),
    onSuccess: () => toast.success("Test alert sent"),
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Alerts"
        description="A webhook: Discord, Slack, or anything that takes a JSON POST"
        actions={
          s.alertWebhookSet && (
            <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
              Send test
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) set({ alertWebhookUrl: url.trim() }, "Webhook saved");
            setUrl("");
          }}
        >
          <Field label="Webhook URL" htmlFor="hook" hint={s.alertWebhookSet ? `Set (${s.alertWebhookHint}). Paste a new one to replace it.` : "Not set: no alerts are sent."}>
            <div className="flex gap-2">
              <Input id="hook" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" />
              <Button type="submit" disabled={!url.trim() || busy}>
                Save
              </Button>
              {s.alertWebhookSet && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => set({ alertWebhookUrl: null }, "Webhook removed")}>
                  Remove
                </Button>
              )}
            </div>
          </Field>
          {s.lastAlertError && <p className="text-xs text-critical">{s.lastAlertError}</p>}
        </form>
        <div className="space-y-3 border-t border-border pt-4">
          <Toggle title="Node offline" description="An agent has been disconnected for 2 minutes (and when it is back)." checked={s.alertOffline} disabled={busy} onChange={(v) => set({ alertOffline: v })} />
          <Toggle title="Lane failing" description="A lane has kept crashing or erroring for 10 minutes (and when it recovers). Waiting out a lease does not count." checked={s.alertLanes} disabled={busy} onChange={(v) => set({ alertLanes: v })} />
          <Toggle title="Job refused or failed" description="Pirate Face refused a submission, or a job ended in an error." checked={s.alertJobs} disabled={busy} onChange={(v) => set({ alertJobs: v })} />
          <Toggle title="Agent errors" description="An agent reports a problem: uv missing, no key, a failed self-update." checked={s.alertAgentErrors} disabled={busy} onChange={(v) => set({ alertAgentErrors: v })} />
        </div>
      </CardBody>
    </Card>
  );
}

function HistoryCard({ s, busy, set }: CardProps) {
  const [days, setDays] = useState(String(s.retentionDays));
  return (
    <Card>
      <CardHeader title="History" />
      <CardBody>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            set({ retentionDays: Number(days) }, "Saved");
          }}
        >
          <Field label="Keep history for (days)" htmlFor="ret" hint="Jobs, events and throughput older than this are deleted hourly. Worker output keeps the last 1000 lines per lane.">
            <div className="flex gap-2">
              <Input id="ret" type="number" min={7} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="max-w-32" />
              <Button type="submit" disabled={busy || Number(days) === s.retentionDays}>
                Save
              </Button>
            </div>
          </Field>
        </form>
      </CardBody>
    </Card>
  );
}

function AgentsTable() {
  const { data: nodes = [] } = useNodes();
  return (
    <Card className="mt-6">
      <CardHeader title="Agents" description="The agent and pirateface version on each node" />
      <Table>
        <thead>
          <tr>
            <Th className="pl-5">Node</Th>
            <Th>Status</Th>
            <Th>Agent</Th>
            <Th>pirateface</Th>
            <Th>CPU</Th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const pf = [...new Set(n.live.lanes.map((l) => l.pfVersion).filter(Boolean))];
            return (
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
                <Td className="font-mono text-xs">{pf.join(", ") || "—"}</Td>
                <Td className="text-text-2">{n.arch ?? "—"}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
