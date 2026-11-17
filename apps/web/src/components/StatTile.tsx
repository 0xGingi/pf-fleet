import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "./ui/card";

export function StatTile({ label, value, sub, icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; icon: LucideIcon }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center gap-2 text-xs font-medium text-text-3">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-3">{sub}</div>}
    </Card>
  );
}
