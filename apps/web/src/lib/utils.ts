import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Categorical series colour by fixed slot (never cycled; callers fold past 8 into "Other"). */
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
