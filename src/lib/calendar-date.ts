/**
 * The one rule for a date a client sends (the usage report's "between" range), shared by the
 * RPC input check and the report itself: "YYYY-MM-DD" naming a real calendar day. So
 * 2026-02-31 and 2026-02-29 are not dates, and 2028-02-29 is.
 */
type CalendarDate = { year: number; month: number; day: number };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The day `text` names, or null when it is not a real "YYYY-MM-DD" day. */
export function parseCalendarDate(text: unknown): CalendarDate | null {
  if (typeof text !== "string") return null;
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}
