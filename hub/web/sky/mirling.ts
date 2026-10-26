// A mirling's own picture (decision 28): a hand-placed pixel map in two walking frames, and its
// colours. The drawn art paints it in the sky, and `npm run icons` draws Mira's icons from it.
// No DOM or Phaser here, so a script can use it too.

/** Creature colours: yellow, and grey when failed. */
export type Palette = 'y' | 'g';

// Each letter is a colour from the palette: o outline, y body, h highlight, s and d shade, e eyes,
// w eye glints, m mouth, k cheeks, f feet.
export const PALETTES: Record<Palette, Record<string, string>> = {
  y: { o: '#5a3b12', y: '#ffd34d', h: '#fff1a8', s: '#e0a42a', d: '#c08420', e: '#1b1420', w: '#ffffff', m: '#7a3a12', k: '#ff9e7a', f: '#5a3b12' },
  g: { o: '#34343c', y: '#8e8e98', h: '#b9b9c2', s: '#6e6e78', d: '#5a5a63', e: '#1b1420', w: '#d0d0d6', m: '#3a3a42', k: '#9a8a90', f: '#34343c' },
};

export const MIRLING: Record<'a' | 'b', string[]> = {
  a: [
    '.....oo....oo.....', '....ohyo..oyyo....', '...ohyyooooyyso...', '..ohyyyyyyyyyyso..',
    '.ohyyyyyyyyyyyyso.', '.ohyyweyyyyweyyso.', 'ohyyyeeyyyyeeyyyso', 'oyyyyeeyyyyeeyyyso',
    'oyykkyyymmyyykkyso', 'oyyyyyyyyyyyyyyyso', 'oyyyyyyyyyyyyyysso', '.oyyyyyyyyyyyysso.',
    '.osyyyyyyyyyyssdo.', '..ossyyyyyyyssdo..', '...oossssssssdo...', '.....oooooooo.....',
    '....offo..offo....', '....oooo..oooo....',
  ],
  b: [
    '.....oo....oo.....', '....ohyo..oyyo....', '...ohyyooooyyso...', '..ohyyyyyyyyyyso..',
    '.ohyyyyyyyyyyyyso.', '.ohyyweyyyyweyyso.', 'ohyyyeeyyyyeeyyyso', 'oyyyyeeyyyyeeyyyso',
    'oyykkyyymmyyykkyso', 'oyyyyyyyyyyyyyyyso', 'oyyyyyyyyyyyyyysso', '.oyyyyyyyyyyyysso.',
    '.osyyyyyyyyyyssdo.', '..ossyyyyyyyssdo..', '...oossssssssdo...', '.....oooooooo.....',
    '...offo....offo...', '...oooo....oooo...',
  ],
};
