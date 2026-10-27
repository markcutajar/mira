// Every mirling has a name of its own (decision 48), kept for the life of its session and never
// shared by two mirlings at once. The hub keeps only a number for each session, its seat; the pack
// chosen in the config turns seats into names, so switching packs renames every mirling at once.

import type { Store } from './store.ts';

export const PACKS = {
  cute: [
    'Pip', 'Bix', 'Nib', 'Momo', 'Wren', 'Fizz', 'Pogo', 'Mochi', 'Biscuit', 'Noodle', 'Sprout', 'Bao', 'Pickle', 'Waffle', 'Pudding', 'Button',
    'Bean', 'Peanut', 'Muffin', 'Toffee', 'Nugget', 'Pebble', 'Puff', 'Doodle', 'Bubbles', 'Jellybean', 'Sprocket', 'Gizmo', 'Widget', 'Ziggy', 'Boba', 'Taro',
    'Miso', 'Yuzu', 'Kiwi', 'Tofu', 'Pretzel', 'Churro', 'Dumpling', 'Gnocchi', 'Olive', 'Pepper', 'Ginger', 'Nutmeg', 'Clove', 'Poppy', 'Bramble', 'Acorn',
    'Hazel', 'Scout', 'Rascal', 'Scamp', 'Tinker', 'Wobble', 'Wiggle', 'Dot', 'Zuzu', 'Kiki', 'Lulu', 'Bo', 'Fig', 'Plum', 'Quince', 'Sesame',
    'Crumpet', 'Scone', 'Bagel', 'Truffle', 'Marzipan', 'Sorbet', 'Fudge', 'Cocoa', 'Latte', 'Mango', 'Papaya', 'Lychee', 'Cricket', 'Beetle', 'Moth', 'Tadpole',
    'Minnow', 'Puffin', 'Wombat', 'Otter', 'Pika', 'Gecko', 'Newt', 'Squeak', 'Chirp', 'Hoot', 'Bounce', 'Jinx', 'Zip', 'Zap', 'Bloop', 'Blip',
    'Ping', 'Pong', 'Tock', 'Tick', 'Rivet', 'Bolt', 'Cog', 'Gadget', 'Pixel', 'Byte', 'Nibble', 'Sprinkle', 'Twinkle', 'Glimmer', 'Comet', 'Snug',
    'Cozy', 'Fluff', 'Tuft', 'Wisp', 'Echo', 'Pippin', 'Tumble', 'Skipper', 'Dash', 'Hopper', 'Scooter', 'Juniper', 'Clementine', 'Biscotti', 'Macaron', 'Mallow',
  ],
  // Proper names of real stars, as the International Astronomical Union lists them. Mira is one too.
  stars: [
    'Vega', 'Altair', 'Rigel', 'Deneb', 'Sirius', 'Polaris', 'Capella', 'Arcturus', 'Aldebaran', 'Betelgeuse', 'Antares', 'Spica', 'Pollux', 'Castor', 'Procyon', 'Regulus',
    'Fomalhaut', 'Achernar', 'Canopus', 'Mimosa', 'Hadar', 'Acrux', 'Gacrux', 'Shaula', 'Bellatrix', 'Elnath', 'Alnilam', 'Alnitak', 'Mintaka', 'Saiph', 'Alhena', 'Mirzam',
    'Wezen', 'Adhara', 'Aludra', 'Alphard', 'Algieba', 'Denebola', 'Zosma', 'Chertan', 'Merak', 'Dubhe', 'Phecda', 'Megrez', 'Alioth', 'Mizar', 'Alcor', 'Alkaid',
    'Thuban', 'Kochab', 'Pherkad', 'Eltanin', 'Rastaban', 'Altais', 'Edasich', 'Izar', 'Muphrid', 'Seginus', 'Nekkar', 'Alphecca', 'Unukalhai', 'Rasalhague', 'Sabik', 'Cebalrai',
    'Rasalgethi', 'Kornephoros', 'Albireo', 'Sadr', 'Gienah', 'Aljanah', 'Fawaris', 'Alderamin', 'Alfirk', 'Errai', 'Schedar', 'Caph', 'Ruchbah', 'Segin', 'Achird', 'Mirach',
    'Almach', 'Alpheratz', 'Scheat', 'Markab', 'Algenib', 'Enif', 'Homam', 'Matar', 'Sadalmelik', 'Sadalsuud', 'Skat', 'Ancha', 'Nashira', 'Dabih', 'Algedi', 'Nunki',
    'Ascella', 'Albaldah', 'Rukbat', 'Electra', 'Maia', 'Merope', 'Taygeta', 'Alcyone', 'Atlas', 'Pleione', 'Celaeno', 'Asterope', 'Menkar', 'Diphda', 'Hamal', 'Sheratan',
    'Mesarthim', 'Algol', 'Mirfak', 'Atik', 'Menkib', 'Menkalinan', 'Hassaleh', 'Almaaz', 'Haedus', 'Tejat', 'Propus', 'Wasat', 'Mekbuda', 'Alzirr', 'Acubens', 'Tarf',
  ],
} as const;

export type Pack = keyof typeof PACKS;

/** How many mirlings can have names at once: the size of the smallest pack. */
export const SEATS = Math.min(...Object.values(PACKS).map((pack) => pack.length));

// A session's first choice of seat, from its ID, so names are spread over the whole pack.
function firstChoice(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % SEATS;
}

export class MirlingNames {
  #store: Store;
  #pack: readonly string[];
  #seats: Map<string, number>;

  constructor(store: Store, pack: Pack = 'cute') {
    this.#store = store;
    this.#pack = PACKS[pack];
    this.#seats = new Map(Object.entries(store.seats()));
  }

  /** The names of these sessions' mirlings, seating any that has none, or whose seat another took first. */
  names(ids: string[], at = new Date().toISOString()): Map<string, string> {
    const taken = new Map<number, string>();
    const unseated: string[] = [];
    for (const id of ids) {
      const seat = this.#seats.get(id);
      if (seat !== undefined && seat < SEATS && !taken.has(seat)) taken.set(seat, id);
      else unseated.push(id);
    }
    for (const id of unseated) {
      let seat = firstChoice(id);
      for (let tries = 0; tries < SEATS && taken.has(seat); tries++) seat = (seat + 1) % SEATS;
      if (taken.has(seat)) continue; // more mirlings than names: this one goes without
      taken.set(seat, id);
      this.#seats.set(id, seat);
      this.#store.setSeat(id, seat, at);
    }
    return new Map([...taken].map(([seat, id]) => [id, this.#pack[seat] as string]));
  }
}
