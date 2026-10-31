// The island's day and night, and its seasons (decision 62), from the clock and the calendar of the
// machine Mira runs on. The sun rises and sets with the time of year, as it would somewhere
// mid-latitude in the north, and the island takes the colours of dawn, a golden hour, dusk and
// night. No DOM or Phaser here, so it can be tested on its own.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Rgb = [number, number, number];

export interface Daylight {
  /** What the island's colours are multiplied by: white by day, warm at either end of it, blue at night. */
  tint: Rgb;
  /** From 0 by day to 1 at night: how far the lamps and windows glow, and the night's stars show. */
  night: number;
  /** Bedtime: mirlings with nothing to do sleep. */
  asleep: boolean;
}

const DAY: Rgb = [1, 1, 1];
const GOLDEN: Rgb = [1, 0.9, 0.74];
const DUSK: Rgb = [0.84, 0.64, 0.76];
const DAWN: Rgb = [0.92, 0.76, 0.74];
const NIGHT: Rgb = [0.5, 0.56, 0.86];
// Mirlings go to bed at ten and get up at half past six, whatever the sun is doing.
const BEDTIME = 22;
const GET_UP = 6.5;
const HOUR_MS = 3_600_000;

const dayOfYear = (date: Date) => Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / (24 * HOUR_MS));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** When the sun rises and sets that day, in hours on the local clock: days are longest in June. */
export function sunHours(date: Date): { rise: number; set: number } {
  const length = 12 + 2.7 * Math.cos((2 * Math.PI * (dayOfYear(date) - 172)) / 365.25);
  const january = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const july = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  // Summer time puts the clock an hour ahead of the sun.
  const noon = 12 + (date.getTimezoneOffset() < Math.max(january, july) ? 1 : 0);
  return { rise: noon - length / 2, set: noon + length / 2 };
}

export function daylightAt(date: Date): Daylight {
  const { rise, set } = sunHours(date);
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const keys: Array<[number, Rgb, number]> = [
    [rise - 1.2, NIGHT, 1],
    [rise - 0.3, DAWN, 0.5],
    [rise + 0.8, DAY, 0],
    [set - 1.4, DAY, 0],
    [set - 0.4, GOLDEN, 0],
    [set + 0.4, DUSK, 0.45],
    [set + 1.3, NIGHT, 1],
  ];
  let tint = NIGHT;
  let night = 1;
  for (let i = 0; i < keys.length - 1; i++) {
    const [from, a, na] = keys[i] as [number, Rgb, number];
    const [to, b, nb] = keys[i + 1] as [number, Rgb, number];
    if (hour < from || hour >= to) continue;
    const t = (hour - from) / (to - from);
    tint = mix(a, b, t);
    night = na + (nb - na) * t;
  }
  return { tint, night, asleep: hour >= BEDTIME || hour < GET_UP };
}

/** The season by the month, as it falls in the north. */
export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  return month < 2 || month === 11 ? 'winter' : month < 5 ? 'spring' : month < 8 ? 'summer' : 'autumn';
}

/** Jack-o'-lanterns come out for the last ten days of October and the first of November. */
export function halloween(date: Date): boolean {
  const month = date.getMonth();
  return (month === 9 && date.getDate() >= 22) || (month === 10 && date.getDate() === 1);
}

// Mira, the star in Cetus Mira is named after, brightens and fades every 332 days or so. The cycle
// here keeps its length and shape, rising faster than it fades, but isn't in step with the real star.
const MIRA_DAYS = 332;
const MIRA_PEAK = Date.UTC(2026, 0, 20);
const MIRA_FADING = 0.62; // of each cycle, after its peak

/** How bright Mira the star is, from 0.15 at its faintest to 1 at its peak, and how it's going. */
export function miraStar(date: Date): { brightness: number; rising: boolean; days: number } {
  const days = (date.getTime() - MIRA_PEAK) / (24 * HOUR_MS);
  const phase = (((days / MIRA_DAYS) % 1) + 1) % 1;
  const rising = phase >= MIRA_FADING;
  const t = rising ? (phase - MIRA_FADING) / (1 - MIRA_FADING) : 1 - phase / MIRA_FADING;
  const brightness = 0.15 + 0.85 * (0.5 - 0.5 * Math.cos(Math.PI * t));
  // Days to its peak while it brightens, or since it while it fades.
  return { brightness, rising, days: Math.round(rising ? (1 - phase) * MIRA_DAYS : phase * MIRA_DAYS) };
}
