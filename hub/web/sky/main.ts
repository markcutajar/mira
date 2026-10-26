// Starts the sky: connects to the hub, draws the island with Phaser, opens a session's story when
// a mirling is clicked, and a project's card when its name is clicked.

import { ago, clock, esc, projectLabel, sessionLabel, STATUS_LABEL } from '../shared/format.ts';
import { connectLive } from '../shared/live.ts';
import { removeThing, renameThing } from '../shared/manage.ts';
import { createPanel, linkedSession } from '../shared/panel.ts';
import { openStart } from '../shared/start.ts';
import { drawnArt } from './drawn-art.ts';
import { SkyScene } from './scene.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
const ORDER = ['needs-me', 'failed', 'my-turn', 'working', 'ended', null];
const skyEl = $('sky');
const card = $('project-card');
const zoomIn = $<HTMLButtonElement>('zoom-in');
const zoomOut = $<HTMLButtonElement>('zoom-out');
let cardFor: string | null = null;

const scene = new SkyScene({
  art: drawnArt(),
  insets: () => ({ top: $('hud-top').getBoundingClientRect().bottom + 8, bottom: window.innerHeight - $('hud-bottom').getBoundingClientRect().top }),
  onSelect: (id) => panel.open(id),
  onSection: (name) => {
    cardFor = name;
    renderCard();
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
  onChange: (id) => scene.select(id, document.querySelector('.panel')?.getBoundingClientRect().width ?? 0),
});

const live = connectLive({
  hold: $<HTMLInputElement>('hold'),
  onConnection: renderConnection,
  // Projects arrive first, in the order they first appeared, so the island keeps its shape between visits.
  onSystems: () => { syncScene(); renderCard(); panel.refresh(); },
  onSessions: () => { syncScene(); renderCounts(); renderCard(); panel.refresh(); },
  onPending: () => { renderCounts(); panel.refresh(); },
  onEvent: (event) => { scene.event(event); panel.event(event); },
  onEvents: renderEvents,
});

function syncScene() {
  const labels = Object.fromEntries(live.systems.filter((s) => s.label).map((s) => [s.name, s.label as string]));
  scene.sync(live.sessions, live.systems.map((s) => s.name), labels);
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
  document.title = needs ? `(${needs}) Mira Sky` : 'Mira Sky';
}

// A project's card: its sessions and where each stands, and what I can do with the project.
function renderCard() {
  const system = cardFor;
  card.hidden = !system;
  if (!system) return;
  const name = projectLabel(system, live.systems);
  const sessions = live.sessions.filter((s) => s.system === system)
    .sort((a, b) => ORDER.indexOf(a.status ?? null) - ORDER.indexOf(b.status ?? null) || b.lastAt.localeCompare(a.lastAt));
  const rows = sessions.map((s) => `<li>
      <span class="pill" data-status="${esc(s.status ?? 'unknown')}">${STATUS_LABEL[s.status ?? ''] ?? 'Unknown'}</span>
      <button type="button" class="title-btn" data-open="${esc(s.id)}" title="Open this session's story">${esc(sessionLabel(s))}</button>
      <span class="faint" data-since="${esc(s.lastAt)}">${esc(ago(s.lastAt))}</span>
    </li>`).join('');
  card.innerHTML = `<header class="card-head">
      <div><p class="eyebrow">Project</p><h2${name !== system ? ` title="${esc(system)}"` : ''}>${esc(name)}</h2></div>
      <button type="button" class="ghost small" data-card="close" aria-label="Close the project card">Close</button>
    </header>
    ${rows ? `<ul class="card-sessions">${rows}</ul>` : '<p class="hint">No sessions here right now.</p>'}
    <div class="actions">
      <button type="button" class="go small" data-card="start">+ New session</button>
      <button type="button" class="ghost small" data-card="rename">Rename</button>
      <button type="button" class="ghost small" data-card="remove">Remove</button>
    </div>`;
}

card.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const system = cardFor;
  if (!system) return;
  const name = projectLabel(system, live.systems);
  const session = (target.closest('[data-open]') as HTMLElement | null)?.dataset.open;
  if (session) return panel.open(session);
  const action = (target.closest('[data-card]') as HTMLElement | null)?.dataset.card;
  if (action === 'close') {
    cardFor = null;
    renderCard();
  } else if (action === 'start') {
    void openStart(system, name);
  } else if (action === 'rename') {
    void renameThing('system', system, name);
  } else if (action === 'remove') {
    void removeThing('system', system, name).then((done) => {
      if (!done) return;
      scene.forget(system);
      cardFor = null;
      renderCard();
    });
  }
});
setInterval(() => {
  for (const el of card.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = ago(el.dataset.since as string);
}, 15000);

function renderEvents() {
  // Token reports arrive after every turn and would crowd out what's happening.
  $('events').innerHTML = live.events.filter((e) => e.type !== 'usage.reported').slice(0, 4).map((e) => {
    const who = e.actor.kind === 'subagent' ? `${projectLabel(e.system, live.systems)} › ${e.actor.name || 'subagent'}` : projectLabel(e.system, live.systems);
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
