// Starts Mira's page (decision 31): the island drawn with Phaser, the board down the left, and a
// session's story on the right. A session row or a mirling opens its story; a project's name on
// either side finds it on the other.

import { clock, esc, projectLabel, toast } from '../shared/format.ts';
import { connectLive } from '../shared/live.ts';
import { createPanel, linkedSession } from '../shared/panel.ts';
import { drawnArt } from './drawn-art.ts';
import { createPalette } from './palette.ts';
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
const buildToggle = $<HTMLButtonElement>('build-toggle');
let building = false;

const sideShown = () => !hud.classList.contains('folded');
const openPanel = () => document.querySelector<HTMLElement>('.panel:not([hidden])');

const scene = new SkyScene({
  art: drawnArt(),
  insets: () => ({
    top: $('hud-top').getBoundingClientRect().bottom + 8,
    bottom: window.innerHeight - $('hud-bottom').getBoundingClientRect().top,
    left: sideShown() ? side.getBoundingClientRect().right + 8 : 0,
    right: openPanel()?.getBoundingClientRect().width ?? (building ? window.innerWidth - $('palette').getBoundingClientRect().left : 0),
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
  // Each change in build mode is kept by the hub as it's made (decision 39).
  onLayout: (name, layout) => {
    palette.canUndo(scene.canUndo);
    fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) })
      .then(async (res) => { if (!res.ok) toast((await res.text()) || `The hub couldn't keep that change (${res.status}).`); })
      .catch(() => toast("The hub isn't reachable, so that change wasn't kept."));
  },
  onBuildHint: (text) => palette.hint(text),
});

const palette = createPalette($('palette'), {
  preview: (tool) => scene.preview(tool),
  onTool: (tool) => scene.setTool(tool),
  onUndo: () => {
    scene.undo();
    palette.canUndo(scene.canUndo);
  },
  onDone: () => setBuild(false),
});

const panel = createPanel({
  session: (id) => live.sessions.find((s) => s.id === id) ?? sidebar.past(id),
  pending: () => live.pending,
  waitSeconds: () => live.waitSeconds,
  projectLabel: (system) => projectLabel(system, live.systems),
  onChange: (id) => {
    if (id) setBuild(false); // a story takes the place of the palette
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
  onLayouts: () => scene.setLayouts(live.layouts),
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
// Build mode (decision 39): the palette opens where the story would, and clicks arrange the island.
function setBuild(on: boolean) {
  if (on === building) return;
  building = on;
  buildToggle.setAttribute('aria-pressed', String(on));
  if (on && panel.current()) panel.close();
  palette.show(on);
  scene.setBuild(on);
  palette.canUndo(scene.canUndo);
  requestAnimationFrame(() => scene.relayout()); // make room for the palette, or give it back
}
buildToggle.addEventListener('click', () => setBuild(!building));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && building && !(e.target as HTMLElement).closest('input, textarea, .term-host')) setBuild(false);
});

zoomIn.addEventListener('click', () => scene.zoomBy(1));
zoomOut.addEventListener('click', () => scene.zoomBy(-1));

if (!('Phaser' in window)) {
  skyEl.innerHTML = '<p class="fallback">The sky needs the Phaser library, which the hub serves from its npm packages. Run npm install in the Mira folder and reload.</p>';
} else {
  // Canvas text needs the fonts in place before the first label is drawn.
  await Promise.race([
    Promise.all([document.fonts.load('600 13px "IBM Plex Mono"'), document.fonts.load('11px "IBM Plex Mono"'), document.fonts.load('12px "IBM Plex Sans"')]),
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
