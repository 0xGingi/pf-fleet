import type { JobView } from "@pf-fleet/protocol/api";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { bytes, dateTime, duration } from "@/lib/format";
import { JobResultBadge } from "./status";
import { Table, Td, Th, Tr } from "./ui/table";

export function JobsTable({ rows, showNode = true, empty = "No jobs yet." }: { rows: JobView[]; showNode?: boolean; empty?: string }) {
  if (!rows.length) return <p className="px-5 py-10 text-center text-sm text-text-3">{empty}</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th className="pl-5">Model</Th>
          {showNode && <Th>Node / lane</Th>}
          <Th className="text-right">Size</Th>
          <Th>Result</Th>
          <Th>Started</Th>
          <Th className="text-right">Took</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((j) => (
          <Tr key={j.id}>
            <Td className="max-w-[28rem]">
              <div className="flex items-center gap-1.5">
                <a
                  href={j.url ?? `https://huggingface.co/${j.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium hover:underline"
                  title={j.repo}
                >
                  {j.repo}
                </a>
                <ExternalLink className="size-3 shrink-0 text-text-3" aria-hidden />
              </div>
              {(j.message || j.infohash) && (
                <div className="mt-0.5 truncate text-xs text-text-3" title={j.message ?? j.infohash ?? ""}>
                  {j.message ?? <span className="font-mono">{j.infohash}</span>}
                </div>
              )}
            </Td>
            {showNode && (
              <Td className="whitespace-nowrap text-text-2">
                {j.nodeName ? (
                  <Link to={`/nodes/${j.nodeId}`} className="hover:underline">
                    {j.nodeName}
                  </Link>
                ) : (
                  <span className="text-text-3">deleted</span>
                )}
                <span className="text-text-3"> / {j.lane}</span>
              </Td>
            )}
            <Td className="text-right whitespace-nowrap text-text-2">{bytes(j.sizeBytes)}</Td>
            <Td>
              <JobResultBadge result={j.result} />
            </Td>
            <Td className="whitespace-nowrap text-text-2">{dateTime(j.startedAt)}</Td>
            <Td className="text-right whitespace-nowrap text-text-2">{duration((j.finishedAt ?? Date.now()) - j.startedAt)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
