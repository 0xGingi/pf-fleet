import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";

const dot: Record<Tone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  serious: "bg-serious",
  critical: "bg-critical",
  neutral: "bg-neutral",
  info: "bg-primary",
};

/** Status always carries a label (and the dot), never colour alone. */
export function Badge({ tone = "neutral", children, className, pulse }: { tone?: Tone; children: ReactNode; className?: string; pulse?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-text-2", className)}>
      <span className={cn("size-1.5 rounded-full", dot[tone], pulse && "animate-pulse")} aria-hidden />
      {children}
    </span>
  );
}
