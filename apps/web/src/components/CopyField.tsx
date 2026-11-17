import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * navigator.clipboard only exists on HTTPS (or localhost); dashboards are often opened over
 * plain http://<ip>:1337, so fall back to execCommand with a hidden textarea. The textarea goes
 * inside `host` so a surrounding dialog's focus trap does not block selecting it.
 */
async function copyText(text: string, host: HTMLElement): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or similar: try the fallback
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  host.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function selectContents(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function CopyField({ value, className, label = "Copy" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLElement>(null);

  return (
    <div ref={box} className={cn("flex items-stretch overflow-hidden rounded-md border border-border bg-surface-2", className)}>
      <code ref={code} className="min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-xs whitespace-nowrap select-all">
        {value}
      </code>
      <button
        type="button"
        className="flex items-center gap-1.5 border-l border-border px-3 text-xs text-text-2 hover:bg-surface hover:text-text"
        onClick={async () => {
          if (box.current && (await copyText(value, box.current))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            return;
          }
          if (code.current) selectContents(code.current);
          toast.error("The browser blocked copying. The command is selected: press Ctrl+C (Cmd+C on a Mac).");
        }}
      >
        {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
