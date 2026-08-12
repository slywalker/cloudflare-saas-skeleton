import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui 標準の className 結合ヘルパー。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
