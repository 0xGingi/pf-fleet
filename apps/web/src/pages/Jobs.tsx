import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/AppShell";
import { JobsTable } from "@/components/JobsTable";
import { RESULT } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { useJobs, useNodes } from "@/lib/queries";

const PAGE = 50;

export function Jobs() {
  const [params, setParams] = useSearchParams();
  const nodeId = params.get("nodeId") ?? "";
  const result = params.get("result") ?? "";
  const repo = params.get("repo") ?? "";
  const page = Number(params.get("page") ?? 0);
  const { data: nodes = [] } = useNodes();
  const { data, isFetching } = useJobs({ nodeId, result, repo, limit: PAGE, offset: page * PAGE });

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <PageHeader title="Jobs" description="Every model a lane leased, and what happened to it" />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="w-64" placeholder="Search model (author/name)" defaultValue={repo} onChange={(e) => set("repo", e.target.value)} aria-label="Search model" />
        <Select className="w-44" value={nodeId} onChange={(e) => set("nodeId", e.target.value)} aria-label="Node">
          <option value="">All nodes</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </Select>
        <Select className="w-44" value={result} onChange={(e) => set("result", e.target.value)} aria-label="Result">
          <option value="">All results</option>
          <option value="running">running</option>
          {Object.entries(RESULT).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      <Card className={isFetching ? "opacity-80" : undefined}>
        <JobsTable rows={data?.rows ?? []} empty="No jobs match." />
        <div className="flex items-center justify-between px-5 py-3 text-xs text-text-3">
          <span>
            {total.toLocaleString()} job{total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={page === 0} onClick={() => set("page", String(page - 1))}>
              Previous
            </Button>
            <span>
              {page + 1} / {pages}
            </span>
            <Button size="sm" disabled={page + 1 >= pages} onClick={() => set("page", String(page + 1))}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
