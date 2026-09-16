import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones
 * in the same group. `clsx` alone would keep both `p-2` and `p-4`; `twMerge`
 * resolves the conflict, which is what lets a component's base classes be
 * overridden by a `className` prop.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
