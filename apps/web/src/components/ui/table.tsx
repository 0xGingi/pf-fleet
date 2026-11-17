import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <div className="overflow-x-auto">
    <table className={cn("w-full text-sm", className)} {...p} />
  </div>
);
export const Th = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn("border-b border-border px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-text-3", className)} {...p} />
);
export const Td = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("border-b border-border px-4 py-2.5 align-middle last:pr-5 first:pl-5", className)} {...p} />
);
export const Tr = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("hover:bg-surface-2/50", className)} {...p} />;
