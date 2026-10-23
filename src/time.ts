/** Usage periods are UTC calendar months, stored as the first day of the month ('YYYY-MM-01'). */
export function periodOf(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** 'YYYY-MM-01' -> 'YYYY-MM' */
export function monthOf(period: string): string {
  return period.slice(0, 7);
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' -> 'YYYY-MM-01' */
export function periodFromMonth(month: string): string {
  return `${month}-01`;
}
