// A PNG from raw pixels, for the app's icons (decision 43) and its taskbar badge (decision 55).

import { crc32, deflateSync } from 'node:zlib';

/** Encodes `rgba`, four bytes to a pixel, row by row from the top. */
export function png(width: number, height: number, rgba: Buffer): Buffer {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height); // each row starts with filter type 0, none
  for (let y = 0; y < height; y++) rgba.copy(raw, y * row + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // red, green, blue and alpha
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
