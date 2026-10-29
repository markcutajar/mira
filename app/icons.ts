// Draws Mira's icons from a mirling's own pixel map (hub/web/sky/mirling.ts): the page's favicon and
// the picture on its notifications (decision 45), and the app's icon for its window and the taskbar
// (decision 43). Run `npm run icons` after changing the map; the files it writes are kept in the repo.

import { writeFileSync } from 'node:fs';
import { MIRLING, PALETTES } from '../hub/web/sky/mirling.ts';
import { png as encode } from './png.ts';

const map = MIRLING.a;
const colours = PALETTES.y;
const SIDE = map.length; // the map is square: 18 × 18

/** The favicon: one rectangle for each run of a colour along a row, crisp at any size. */
function svg(): string {
  const rects: string[] = [];
  map.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x] as string;
      let end = x + 1;
      while (row[end] === ch) end++;
      const fill = colours[ch];
      if (fill) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIDE} ${SIDE}" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

/** The mirling filling a square image, each pixel taking the colour of the map's nearest one. */
function pixels(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hex = colours[map[Math.floor((y * SIDE) / size)]?.[Math.floor((x * SIDE) / size)] ?? '.'];
      if (!hex) continue;
      out.writeUInt32BE(((parseInt(hex.slice(1), 16) << 8) | 0xff) >>> 0, (y * size + x) * 4);
    }
  }
  return out;
}

const png = (size: number) => encode(size, size, pixels(size));

/** A Windows icon holding a PNG at each size the title bar, taskbar and Start menu ask for. */
function ico(sizes: number[]): Buffer {
  const images = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    const image = images[i] as Buffer;
    head[at] = size % 256; // 0 means 256
    head[at + 1] = size % 256;
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(image.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([head, ...images]);
}

writeFileSync(new URL('../hub/web/favicon.svg', import.meta.url), svg());
writeFileSync(new URL('icon.ico', import.meta.url), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
writeFileSync(new URL('../hub/web/mirling.png', import.meta.url), png(90)); // five pixels to each of the map's
writeFileSync(new URL('icon.png', import.meta.url), png(256));
console.log('Wrote hub/web/favicon.svg, hub/web/mirling.png, app/icon.ico and app/icon.png.');
