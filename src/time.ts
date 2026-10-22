/** Time-zone helpers (no dependencies: Intl does the tz database work). */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(t: number | Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset (ms) of `tz` from UTC at instant t: wall clock minus UTC. */
function tzOffset(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

/** "YYYY-MM-DD" of instant t in tz (e.g. the New York trading day). */
export function zonedDayKey(t: number | Date, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC instant (ms) of local wall-clock time y-m-d h:m in tz. DST-safe. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - tzOffset(guess, tz);
  const off2 = tzOffset(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

/** UTC instant (ms) of 00:00 local time of the day containing t in tz. */
export function startOfZonedDay(t: number | Date, tz: string): number {
  const p = zonedParts(t, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Minutes since local midnight in tz. */
export function zonedMinuteOfDay(t: number | Date, tz: string): number {
  const p = zonedParts(t, tz);
  return p.hour * 60 + p.minute;
}
