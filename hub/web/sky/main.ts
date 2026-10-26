// Starts the sky: connects to the hub, draws the island with Phaser, and opens a session's story
// when a mirling is clicked.

import { clock, esc } from '../shared/format.ts';
import { connectLive } from '../shared/live.ts';
import { createPanel, linkedSession } from '../shared/panel.ts';
import { drawnArt } from './drawn-art.ts';
import { SkyScene } from './scene.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
const skyEl = $('sky');
const zoomIn = $<HTMLButtonElement>('zoom-in');
const zoomOut = $<HTMLButtonElement>('zoom-out');

// The projects in the order they first appeared, so the island keeps its shape between visits.
const systemsReady: Promise<string[]> = fetch('/api/systems')
  .then((res) => res.json() as Promise<{ systems: Array<{ name: string }> }>)
  .then((body) => body.systems.map((s) => s.name))
  .catch(() => []);
let systems: string[] = [];

const scene = new SkyScene({
  art: drawnArt(),
  insets: () => ({ top: $('hud-top').getBoundingClientRect().bottom + 8, bottom: window.innerHeight - $('hud-bottom').getBoundingClientRect().top }),
  onSelect: (id) => panel.open(id),
  onZoom: (name, closer, further) => {
    $('zoom-label').textContent = name;
    zoomIn.disabled = !closer;
    zoomOut.disabled = !further;
  },
});

const panel = createPanel({
  session: (id) => live.sessions.find((s) => s.id === id),
  pending: () => live.pending,
  waitSeconds: () => live.waitSeconds,
  onChange: (id) => scene.select(id, document.querySelector('.panel')?.getBoundingClientRect().width ?? 0),
});

const live = connectLive({
  hold: $<HTMLInputElement>('hold'),
  onConnection: renderConnection,
  onSessions: () => {
    void systemsReady.then((list) => {
      systems = list;
      scene.sync(live.sessions, systems);
      renderEmpty();
    });
    renderCounts();
    panel.refresh();
  },
  onPending: () => { renderCounts(); panel.refresh(); },
  onEvent: (event) => { scene.event(event); panel.event(event); },
  onEvents: renderEvents,
});

function renderConnection() {
  const el = $('conn');
  el.dataset.state = live.connected ? 'up' : 'down';
  el.textContent = live.connected ? 'Live' : 'Hub not reachable, retrying…';
}

function renderCounts() {
  const counts: Record<string, number> = { working: 0, 'needs-me': 0, 'my-turn': 0, failed: 0 };
  for (const s of live.sessions) if (s.status && s.status in counts) counts[s.status] = (counts[s.status] ?? 0) + 1;
  for (const [status, n] of Object.entries(counts)) $(`n-${status}`).textContent = String(n);
  const needs = Math.max(counts['needs-me'] ?? 0, live.pending.length);
  const chip = $<HTMLButtonElement>('chip-needs');
  chip.classList.toggle('on', needs > 0);
  chip.disabled = needs === 0;
  document.title = needs ? `(${needs}) Mira Sky` : 'Mira Sky';
}

function renderEmpty() {
  $('empty').hidden = live.sessions.length > 0 || systems.length > 0;
}

function renderEvents() {
  // Token reports arrive after every turn and would crowd out what's happening.
  $('events').innerHTML = live.events.filter((e) => e.type !== 'usage.reported').slice(0, 4).map((e) => {
    const who = e.actor.kind === 'subagent' ? `${e.system} › ${e.actor.name || 'subagent'}` : e.system;
    const what = e.detail?.tool ?? e.detail?.notification ?? e.detail?.reason ?? e.detail?.decision ?? '';
    return `<li><span class="t">${esc(clock(e.at))}</span><span class="who">${esc(who)}</span><span class="type">${esc(e.type)}</span><span class="what">${esc(what)}</span></li>`;
  }).join('');
}

$('chip-needs').addEventListener('click', () => {
  const id = scene.focusNextNeeds();
  if (id) panel.open(id);
});
zoomIn.addEventListener('click', () => scene.zoomBy(1));
zoomOut.addEventListener('click', () => scene.zoomBy(-1));

if (!('Phaser' in window)) {
  skyEl.innerHTML = '<p class="fallback">The sky needs the Phaser library, which the hub serves from its npm packages. Run npm install in the Mira folder and reload.</p>';
} else {
  // Canvas text needs the fonts in place before the first label is drawn.
  await Promise.race([
    Promise.all([document.fonts.load('14px "Pixelify Sans"'), document.fonts.load('11px "IBM Plex Mono"'), document.fonts.load('12px "IBM Plex Sans"')]),
    new Promise((done) => setTimeout(done, 1500)),
  ]).catch(() => {});
  const d = DPR();
  // Drawn at the screen's real pixel density, so the detailed art stays sharp.
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: skyEl,
    backgroundColor: '#0b0d1a',
    pixelArt: true,
    roundPixels: true,
    banner: false,
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.NONE, width: Math.round(skyEl.clientWidth * d), height: Math.round(skyEl.clientHeight * d), zoom: 1 / d },
    scene: [scene],
  });
  window.addEventListener('resize', () => {
    const dd = DPR();
    game.scale.resize(Math.round(skyEl.clientWidth * dd), Math.round(skyEl.clientHeight * dd));
    game.scale.setZoom(1 / dd);
  });
}

const linked = linkedSession();
if (linked) panel.open(linked);
