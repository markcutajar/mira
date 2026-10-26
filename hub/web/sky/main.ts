// Starts Mira's page (decision 31): the island drawn with Phaser, the board down the left, and a
// session's story on the right. A session row or a mirling opens its story; a project's name on
// either side finds it on the other.

import { clock, esc, projectLabel } from '../shared/format.ts';
import { connectLive } from '../shared/live.ts';
import { createPanel, linkedSession } from '../shared/panel.ts';
import { drawnArt } from './drawn-art.ts';
import { SkyScene } from './scene.ts';
import { createSidebar } from './sidebar.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
const SIDE_KEY = 'mira.side';
const hud = $('hud');
const side = $('sidebar');
const toggle = $<HTMLButtonElement>('side-toggle');
const skyEl = $('sky');
const zoomIn = $<HTMLButtonElement>('zoom-in');
const zoomOut = $<HTMLButtonElement>('zoom-out');

const sideShown = () => !hud.classList.contains('folded');
const openPanel = () => document.querySelector<HTMLElement>('.panel:not([hidden])');

const scene = new SkyScene({
  art: drawnArt(),
  insets: () => ({
    top: $('hud-top').getBoundingClientRect().bottom + 8,
    bottom: window.innerHeight - $('hud-bottom').getBoundingClientRect().top,
    left: sideShown() ? side.getBoundingClientRect().right + 8 : 0,
    right: openPanel()?.getBoundingClientRect().width ?? 0,
  }),
  onSelect: (id) => panel.open(id),
  onSection: (name) => {
    setSide(true);
    sidebar.showProject(name);
  },
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
  projectLabel: (system) => projectLabel(system, live.systems),
  onChange: (id) => {
    scene.select(id);
    if (id) scene.reveal(id);
    else scene.showIsland(); // closing a story goes back to the whole island
    sidebar.render();
  },
});

// The live link only calls back once data arrives, by which time the side panel below exists.
const live = connectLive({
  hold: $<HTMLInputElement>('hold'),
  onConnection: renderConnection,
  // Projects arrive first, in the order they first appeared, so the island keeps its shape between visits.
  onSystems: () => { syncScene(); sidebar.render(); panel.refresh(); },
  onSessions: () => { syncScene(); renderCounts(); sidebar.render(); panel.refresh(); },
  onPending: () => { renderCounts(); sidebar.render(); panel.refresh(); },
  onEvent: (event) => { scene.event(event); panel.event(event); },
  onEvents: renderEvents,
});

const sidebar = createSidebar(side, {
  live,
  current: () => panel.current(),
  onSession: (id) => {
    panel.open(id);
    scene.focusSession(id);
  },
  onProject: (name) => scene.focusSection(name),
  onRemoved: (kind, key) => { if (kind === 'system') scene.forget(key); },
});

function syncScene() {
  const labels = Object.fromEntries(live.systems.filter((s) => s.label).map((s) => [s.name, s.label as string]));
  const growth = Object.fromEntries(live.systems.filter((s) => s.growth).map((s) => [s.name, s.growth as NonNullable<typeof s.growth>]));
  scene.sync(live.sessions, live.systems.map((s) => s.name), labels, growth);
  $('empty').hidden = live.sessions.length > 0 || live.systems.length > 0;
}

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
  document.title = needs ? `(${needs}) Mira` : 'Mira';
}

function renderEvents() {
  // Token reports arrive after every turn and would crowd out what's happening.
  $('events').innerHTML = live.events.filter((e) => e.type !== 'usage.reported').slice(0, 4).map((e) => {
    const project = projectLabel(e.system, live.systems);
    const who = e.actor.kind === 'subagent' ? `${project} › ${e.actor.name || 'subagent'}` : project;
    const what = e.detail?.tool ?? e.detail?.notification ?? e.detail?.reason ?? e.detail?.decision ?? '';
    return `<li><span class="t">${esc(clock(e.at))}</span><span class="who">${esc(who)}</span><span class="type">${esc(e.type)}</span><span class="what">${esc(what)}</span></li>`;
  }).join('');
}

// The side panel folds away for more island; folded on narrow screens unless I opened it.
function setSide(shown: boolean, remember = true) {
  if (shown === sideShown()) return;
  hud.classList.toggle('folded', !shown);
  toggle.setAttribute('aria-pressed', String(shown));
  if (remember) try { localStorage.setItem(SIDE_KEY, shown ? 'open' : 'folded'); } catch { /* not remembered */ }
  requestAnimationFrame(() => scene.relayout());
}
let remembered: string | null = null;
try { remembered = localStorage.getItem(SIDE_KEY); } catch { /* storage unavailable */ }
setSide(remembered ? remembered === 'open' : window.innerWidth > 900, false);
toggle.addEventListener('click', () => setSide(!sideShown()));

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
