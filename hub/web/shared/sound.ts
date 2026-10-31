// Mira's sounds (decision 69), all made in the page with Web Audio, so there are no files to load or
// license: a chime when a session calls for me, and the island's own, from a hammer's tap to a
// firework. Both are off until switched on in Settings, with one volume for all.

export type SoundName =
  | 'needs-me' | 'failed' | 'my-turn' | 'clash'
  | 'hammer' | 'splash' | 'firework' | 'cheer' | 'levelup' | 'boop' | 'thud' | 'birds';

export interface SoundSwitches {
  chime: HTMLInputElement;
  island: HTMLInputElement;
  volume: HTMLInputElement;
}

export interface Sound {
  /** A session started calling for me. */
  chime(name: 'needs-me' | 'failed' | 'my-turn' | 'clash'): void;
  /** Something happened on the island, `pan` from -1 at the left of the screen to 1 at the right. */
  island(name: Exclude<SoundName, 'needs-me' | 'failed' | 'my-turn' | 'clash'>, pan?: number): void;
}

const KEYS = { chime: 'mira.chime', island: 'mira.sounds', volume: 'mira.volume' };
// The quickest a sound comes again, so a busy island taps rather than rattles.
const AGAIN_MS: Partial<Record<SoundName, number>> = { hammer: 220, splash: 400, boop: 120, birds: 4000 };

export function createSound(els: SoundSwitches): Sound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  const last = new Map<SoundName, number>();

  const read = (key: string) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const keep = (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { /* for this visit only */ }
  };
  els.chime.checked = read(KEYS.chime) === 'on';
  els.island.checked = read(KEYS.island) === 'on';
  els.volume.value = read(KEYS.volume) ?? '50';

  // The browser lets a page make sound only once I've touched it, which switching a sound on does.
  function start(): boolean {
    if (!ctx) {
      try {
        ctx = new AudioContext();
      } catch {
        return false;
      }
      master = ctx.createGain();
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    if (master) master.gain.value = (Number(els.volume.value) / 100) ** 2 * 0.5;
    return true;
  }

  els.chime.addEventListener('change', () => {
    keep(KEYS.chime, els.chime.checked ? 'on' : 'off');
    if (els.chime.checked && start()) play('my-turn');
  });
  els.island.addEventListener('change', () => {
    keep(KEYS.island, els.island.checked ? 'on' : 'off');
    if (els.island.checked && start()) play('cheer');
  });
  els.volume.addEventListener('change', () => {
    keep(KEYS.volume, els.volume.value);
    if (start()) play('boop');
  });
  // The app may make sound from the start; a browser page opened with a sound already switched on
  // wakes its sound at the first touch.
  if (window.miraApp && (els.chime.checked || els.island.checked)) start();
  const wake = () => { if (els.chime.checked || els.island.checked) start(); };
  window.addEventListener('pointerdown', wake, { capture: true });
  window.addEventListener('keydown', wake, { capture: true });

  /** A note: a wave from one pitch to another, rising fast and dying away. */
  function tone(at: number, from: number, to: number, length: number, level: number, wave: OscillatorType = 'sine', out?: AudioNode) {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + length);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(out ?? master);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }

  /** A burst of noise through a filter sweeping from one frequency to another. */
  function hiss(at: number, kind: BiquadFilterType, from: number, to: number, length: number, level: number, out?: AudioNode) {
    if (!ctx || !master || !noise) return;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noise;
    filter.type = kind;
    filter.frequency.setValueAtTime(from, at);
    filter.frequency.exponentialRampToValueAtTime(to, at + length);
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(filter).connect(gain).connect(out ?? master);
    src.start(at, Math.random() * 0.5);
    src.stop(at + length + 0.02);
  }

  function play(name: SoundName, pan = 0): void {
    if (!ctx || !master || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const again = AGAIN_MS[name];
    if (again && now * 1000 - (last.get(name) ?? -Infinity) < again) return;
    last.set(name, now * 1000);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);
    const t = now + 0.01;
    switch (name) {
      case 'needs-me': // a rising call: someone wants me
        tone(t, 659, 659, 0.22, 0.5, 'triangle', panner);
        tone(t + 0.14, 880, 880, 0.4, 0.5, 'triangle', panner);
        break;
      case 'my-turn': // a soft bell: done
        tone(t, 1047, 1047, 0.9, 0.35, 'sine', panner);
        tone(t, 2890, 2890, 0.35, 0.06, 'sine', panner);
        break;
      case 'failed': // falling and low
        tone(t, 392, 370, 0.25, 0.35, 'triangle', panner);
        tone(t + 0.18, 294, 262, 0.45, 0.35, 'triangle', panner);
        break;
      case 'clash': // two notes at once, a little apart
        tone(t, 587, 587, 0.35, 0.3, 'triangle', panner);
        tone(t + 0.05, 622, 622, 0.35, 0.25, 'triangle', panner);
        break;
      case 'hammer':
        hiss(t, 'bandpass', 2400, 1800, 0.05, 0.25, panner);
        tone(t, 900, 600, 0.04, 0.08, 'square', panner);
        break;
      case 'splash':
        hiss(t, 'lowpass', 1800, 300, 0.32, 0.35, panner);
        break;
      case 'firework':
        hiss(t, 'highpass', 400, 3000, 0.6, 0.08, panner);
        hiss(t + 0.62, 'lowpass', 1200, 200, 0.35, 0.6, panner);
        for (let i = 0; i < 5; i++) hiss(t + 0.7 + i * 0.07 + Math.random() * 0.04, 'highpass', 4000, 6000, 0.03, 0.12, panner);
        break;
      case 'cheer':
        tone(t, 1047, 1047, 0.1, 0.25, 'triangle', panner);
        tone(t + 0.09, 1319, 1319, 0.16, 0.25, 'triangle', panner);
        break;
      case 'levelup':
        [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.08, f, f, 0.22, 0.25, 'triangle', panner));
        break;
      case 'boop':
        tone(t, 520, 760, 0.12, 0.25, 'sine', panner);
        break;
      case 'thud':
        tone(t, 140, 55, 0.14, 0.5, 'sine', panner);
        hiss(t, 'lowpass', 600, 150, 0.08, 0.15, panner);
        break;
      case 'birds':
        for (let i = 0; i < 3; i++) tone(t + i * 0.13 + Math.random() * 0.05, 2600, 3600, 0.06, 0.06, 'sine', panner);
        break;
    }
  }

  return {
    chime(name) {
      if (els.chime.checked) play(name);
    },
    island(name, pan = 0) {
      if (els.island.checked) play(name, pan);
    },
  };
}
