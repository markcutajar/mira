// What Mira costs the machine (decision 61), in Settings while it's open: the hub, the terminal host,
// the island's frames, and in the app each of its own processes, with their CPU as Task Manager
// counts it and their memory. The island is drawn at most 60 times a second, which pixel art needs
// no more than, however fast the screen refreshes, and 20 while Mira isn't in front unless I switch
// that off here.

import type { AppPart, AppUsage, FootprintReport, Usage } from '../../src/footprint-report.ts';
import { esc } from '../shared/format.ts';

export interface Footprint {
  /** Measures while Settings is open, and stops when it closes. */
  show(open: boolean): void;
  /** Paces the island's game, given before it starts running, and counts its frames. */
  pace(game: Phaser.Game): void;
}

const MAX_FPS = 60;
const CALM_FPS = 20;
const CALM_KEY = 'mira.calm';
const EVERY_MS = 2000;
// A frame due within this much of now is drawn, so a screen at 60 Hz draws every one.
const SLACK_MS = 1;
const PART_LABEL: Record<AppPart, string> = { window: 'Island and panels', popup: 'Pop-up', graphics: 'Graphics', app: 'App' };

const percent = (cpu: number) => `${(cpu * 100).toFixed(cpu < 0.1 ? 1 : 0)}%`;
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function createFootprint(els: { box: HTMLElement; calm: HTMLInputElement }): Footprint {
  const { box, calm } = els;
  let timer: number | undefined;
  let frames = 0;
  let busy = 0;
  let counted = performance.now();
  let rate = 1000 / MAX_FPS;
  let primed = false;

  let calmOn = true;
  try { calmOn = localStorage.getItem(CALM_KEY) !== 'off'; } catch { /* storage unavailable: on */ }
  calm.checked = calmOn;
  calm.addEventListener('change', () => {
    calmOn = calm.checked;
    try { localStorage.setItem(CALM_KEY, calmOn ? 'on' : 'off'); } catch { /* for this visit only */ }
    setRate();
  });
  const setRate = () => { rate = 1000 / (calmOn && !document.hasFocus() ? CALM_FPS : MAX_FPS); };
  window.addEventListener('focus', setRate);
  window.addEventListener('blur', setRate);

  // How many frames the island drew since the last look, and how long each took to work out.
  function frameStats() {
    const now = performance.now();
    const stats = { fps: (frames * 1000) / Math.max(1, now - counted), ms: frames ? busy / frames : 0 };
    frames = 0;
    busy = 0;
    counted = now;
    return stats;
  }

  async function measure() {
    const [hub, app] = await Promise.all([
      fetch('/api/footprint').then((res) => (res.ok ? (res.json() as Promise<FootprintReport>) : null)).catch(() => null),
      window.miraApp?.metrics?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    const island = frameStats();
    // The first reading after opening covers however long Settings was closed; it only starts the clocks.
    if (!primed) {
      primed = true;
      box.innerHTML = '<p class="hint">Measuring…</p>';
      return;
    }
    render(hub, app, island);
  }

  function render(hub: FootprintReport | null, app: AppUsage | null, island: { fps: number; ms: number }) {
    const rows: Array<[string, Usage | null, string?]> = [];
    for (const part of ['window', 'graphics', 'popup', 'app'] as AppPart[]) {
      const usage = app?.find((p) => p.part === part);
      if (usage) rows.push([PART_LABEL[part], usage]);
    }
    if (hub) {
      rows.push(['Hub', hub.hub]);
      const t = hub.terminals;
      if (t) rows.push([`Terminals · ${t.running}`, t.usage ?? null, t.usage ? undefined : 'Measured once their host restarts']);
    } else rows.push(['Hub', null, "The hub isn't reachable"]);
    const measured = rows.map(([, usage]) => usage).filter((u): u is Usage => Boolean(u));
    const total = measured.reduce((sum, u) => ({ cpu: sum.cpu + u.cpu, memory: sum.memory + u.memory }), { cpu: 0, memory: 0 });
    const cells = (u: Usage | null, note?: string) => (u ? `<td>${percent(u.cpu)}</td><td>${megabytes(u.memory)}</td>` : `<td colspan="2" class="hint">${esc(note ?? '')}</td>`);
    const body = rows.map(([label, usage, note]) => `<tr><th>${esc(label)}</th>${cells(usage, note)}</tr>`).join('');
    const sum = app ? `<tr class="total"><th>All of Mira</th>${cells(total)}</tr>` : '';
    const frames = `The island drew ${Math.round(island.fps)} frames a second, ${island.ms.toFixed(1)} ms of work each.`;
    const where = app ? '' : " Your browser's own task manager (Shift+Esc) shows what this tab costs.";
    box.innerHTML = `<table><thead><tr><th></th><th>CPU</th><th>Memory</th></tr></thead><tbody>${body}${sum}</tbody></table>
      <p class="hint">${frames}${where} Claude Code's own sessions aren't counted.</p>`;
  }

  return {
    show(open) {
      window.clearInterval(timer);
      timer = undefined;
      if (!open) return;
      primed = false;
      void measure();
      timer = window.setInterval(() => void measure(), EVERY_MS);
    },
    pace(game) {
      // The game's own limiter drops frames at random on a 60 Hz screen, so its step is wrapped before
      // its loop starts: a frame comes due every `rate`, and the time skipped goes to the next one drawn.
      const step = game.step.bind(game);
      let due = 0;
      let skipped = 0;
      setRate();
      game.step = (time: number, delta: number) => {
        skipped += delta;
        if (time + SLACK_MS < due) return;
        due = time - due < rate ? due + rate : time + rate;
        const start = performance.now();
        step(time, skipped);
        busy += performance.now() - start;
        frames++;
        skipped = 0;
      };
      if (game.isRunning) game.loop.callback = game.step;
    },
  };
}
