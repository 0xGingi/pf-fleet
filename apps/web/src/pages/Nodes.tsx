import type { CreatedNode, NodeView } from "@pf-fleet/protocol/api";
import { useMutation } from "@tanstack/react-query";
import { Cpu, MemoryStick, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { InstallCommand } from "@/components/InstallCommand";
import { LaneProgress } from "@/components/LaneProgress";
import { AgentUpdateBadge, NodeStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ApiError, post } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { useAccounts, useNodes } from "@/lib/queries";

export function Nodes() {
  const { data: nodes, isLoading } = useNodes();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title="Nodes"
        description="Machines running the pf-fleet agent"
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add node
          </Button>
        }
      />
      {!isLoading && !nodes?.length && (
        <Card className="px-6 py-16 text-center">
          <p className="text-sm font-medium">No nodes yet</p>
          <p className="mt-1 text-sm text-text-3">Add one to get an install command for the machine.</p>
          <Button variant="primary" className="mt-4" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add node
          </Button>
        </Card>
      )}
      {!!nodes?.length && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {nodes.map((n) => (
            <NodeCard key={n.id} node={n} />
          ))}
        </div>
      )}
      <AddNodeDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function NodeCard({ node }: { node: NodeView }) {
  const sys = node.live.system;
  const memUsed = sys ? sys.memTotal - sys.memAvailable : 0;
  return (
    <Link to={`/nodes/${node.id}`} className="group block">
      <Card className="h-full transition-colors group-hover:border-text-3/40">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{node.name}</div>
            <div className="mt-0.5 truncate text-xs text-text-3">
              {node.hostname ?? "not installed yet"}
              {node.accountName && ` · ${node.accountName}`}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <NodeStatusBadge node={node} />
            <AgentUpdateBadge node={node} />
          </div>
        </div>
        <div className="space-y-3 px-5 py-4">
          {node.lanes.length === 0 ? (
            <p className="text-xs text-text-3">No lanes configured.</p>
          ) : (
            node.lanes.map((l) => <LaneProgress key={l.name} config={l} status={node.live.lanes.find((s) => s.name === l.name)} online={node.live.connected} compact />)
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-xs text-text-3">
          {sys ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Cpu className="size-3" aria-hidden /> load {sys.load1.toFixed(2)}
                {node.cpus ? ` / ${node.cpus} cpu` : ""}
              </span>
              <span className="inline-flex items-center gap-1">
                <MemoryStick className="size-3" aria-hidden /> {bytes(memUsed)} of {bytes(sys.memTotal)}
              </span>
            </>
          ) : (
            <span>last seen {ago(node.lastSeenAt)}</span>
          )}
        </div>
      </Card>
    </Link>
  );
}

function AddNodeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: accounts = [] } = useAccounts();
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [created, setCreated] = useState<CreatedNode | null>(null);
  const create = useMutation({
    mutationFn: () => post<CreatedNode>("/api/nodes", { name, accountId: accountId || accounts[0]?.id || null }),
    onSuccess: (res) => setCreated(res),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "could not add the node"),
  });
  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setCreated(null);
      setName("");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={created ? `Install on ${created.node.name}` : "Add a node"}
      description={created ? undefined : "A node is one machine. You choose its lanes after it connects."}
      className="max-w-2xl"
      footer={
        created ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        )
      }
    >
      {created ? (
        <InstallCommand command={created.installCommand} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label="Name" htmlFor="node-name" hint="Letters, digits, '.', '_' or '-'. Usually the hostname.">
            <Input id="node-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="seedbox" autoFocus />
          </Field>
          <Field label="Pirate Face account" htmlFor="node-account" hint={accounts.length ? "Lanes on this node work under this account's key." : "Add an account first to run lanes."}>
            <Select id="node-account" value={accountId || accounts[0]?.id || ""} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.length === 0 && <option value="">No accounts yet</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      )}
    </Dialog>
  );
}
