// The red badge on Mira's taskbar button (decision 55): how many sessions are calling for me, in
// pixel digits like the island's. Windows draws it over the corner of the button.

import { png } from './png.ts';

const SIZE = 32; // shown at 16 × 16, drawn twice as fine
const RED: Rgb = [0xe5, 0x38, 0x3b];
const EDGE: Rgb = [0x0b, 0x0d, 0x1a]; // the night sky's colour, so the dot stands out on any taskbar
const WHITE: Rgb = [0xff, 0xff, 0xff];
type Rgb = [number, number, number];

// Three by five pixels each.
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
};

/** A PNG of the badge for `count`, which shows as 9+ past nine. */
export function badgePng(count: number): Buffer {
  const text = count > 9 ? '9+' : String(count);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb) => rgba.set([r, g, b, 0xff], (y * SIZE + x) * 4);
  const middle = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const from = Math.hypot(x - middle, y - middle);
      if (from <= middle + 0.5) put(x, y, from > middle - 1.5 ? EDGE : RED);
    }
  }
  const scale = text.length === 1 ? 4 : 3;
  const left = Math.round((SIZE - (text.length * 4 - 1) * scale) / 2);
  const top = Math.round((SIZE - 5 * scale) / 2);
  [...text].forEach((ch, i) => GLYPHS[ch]?.forEach((line, gy) => [...line].forEach((pixel, gx) => {
    if (pixel !== '#') return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(left + (i * 4 + gx) * scale + dx, top + gy * scale + dy, WHITE);
  })));
  return png(SIZE, SIZE, rgba);
}
