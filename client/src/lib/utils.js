/**
 * Utility: merge CSS class names, filtering out falsy values.
 * Lightweight alternative to clsx/cn for this project.
 */
export function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}
