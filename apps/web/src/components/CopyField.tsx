import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function CopyField({ value, className, label = "Copy" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-stretch overflow-hidden rounded-md border border-border bg-surface-2", className)}>
      <code className="min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-xs whitespace-nowrap select-all">{value}</code>
      <button
        type="button"
        className="flex items-center gap-1.5 border-l border-border px-3 text-xs text-text-2 hover:bg-surface hover:text-text"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
