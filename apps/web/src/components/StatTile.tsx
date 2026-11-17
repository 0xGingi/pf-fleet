import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "./ui/card";

export function StatTile({ label, value, sub, icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; icon: LucideIcon }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[13px] text-text-3">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-xl sm:text-[1.65rem] leading-tight font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-3">{sub}</div>}
    </Card>
  );
}
