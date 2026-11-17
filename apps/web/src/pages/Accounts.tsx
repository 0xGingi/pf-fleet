import type { AccountView } from "@pf-fleet/protocol/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { ConfirmButton } from "@/components/Confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { ApiError, del, patch, post } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { keys, useAccounts } from "@/lib/queries";

const LANES_PER_ACCOUNT = 3;

export function Accounts() {
  const { data: accounts = [], isLoading } = useAccounts();
  const [editing, setEditing] = useState<AccountView | "new" | null>(null);
  const qc = useQueryClient();
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Pirate Face accounts your lanes work under. Keys are encrypted at rest and only sent to that account's agents."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> Add account
          </Button>
        }
      />
      <Card>
        {!isLoading && accounts.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-text-3">No accounts yet. Add one with its community torrent key from pirateface.co/settings.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-5">Name</Th>
                <Th>Key</Th>
                <Th>Nodes</Th>
                <Th className="w-56">Lanes in use</Th>
                <Th>Added</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <Tr key={a.id}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td>{a.hasKey ? <span className="font-mono text-xs text-text-2">{a.keyHint}</span> : <Badge tone="warning">no key</Badge>}</Td>
                  <Td className="text-text-2">{a.nodeCount}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Progress value={(a.enabledLanes / LANES_PER_ACCOUNT) * 100} label={`${a.name} lanes`} className="w-24" />
                      <span className="text-xs text-text-2">
                        {a.enabledLanes} / {LANES_PER_ACCOUNT}
                      </span>
                    </div>
                  </Td>
                  <Td className="text-text-2">{dateTime(a.createdAt)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                        <Pencil className="size-4" />
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        size="icon"
                        title={`Delete ${a.name}?`}
                        description={a.nodeCount ? "Move its nodes to another account first." : "Its key is deleted from the dashboard."}
                        confirmLabel="Delete account"
                        onConfirm={() =>
                          del(`/api/accounts/${a.id}`)
                            .then(() => qc.invalidateQueries({ queryKey: keys.accounts }))
                            .catch((e) => toast.error(e instanceof ApiError ? e.message : "could not delete"))
                        }
                      >
                        <Trash2 className="size-4" />
                      </ConfirmButton>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <AccountDialog account={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function AccountDialog({ account, onClose }: { account: AccountView | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = account === "new";
  const current = account && account !== "new" ? account : null;
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [lastOpened, setLastOpened] = useState<typeof account>(null);
  if (account !== lastOpened) {
    setLastOpened(account);
    setName(current?.name ?? "");
    setKey("");
  }
  const save = useMutation({
    mutationFn: () =>
      isNew ? post("/api/accounts", { name: name.trim(), key: key.trim() || undefined }) : patch(`/api/accounts/${current!.id}`, { name: name.trim(), ...(key.trim() ? { key: key.trim() } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.accounts });
      toast.success(isNew ? "Account added" : "Saved; its nodes got the change");
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "could not save"),
  });
  return (
    <Dialog
      open={!!account}
      onOpenChange={(v) => !v && onClose()}
      title={isNew ? "Add account" : `Edit ${current?.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field label="Name" htmlFor="a-name" hint="Your Pirate Face handle is a good choice.">
          <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field
          label={isNew ? "Community torrent key" : "Replace key"}
          htmlFor="a-key"
          hint={
            <>
              From pirateface.co/settings, starts with <code>pfct_</code>.{current?.hasKey ? ` Leave empty to keep ${current.keyHint}.` : ""}
            </>
          }
        >
          <Input id="a-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="pfct_…" className="font-mono" />
        </Field>
      </form>
    </Dialog>
  );
}
