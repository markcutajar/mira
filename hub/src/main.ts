// Starts the hub: rebuilds the live picture from storage and each source, then listens.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { claudeCode } from './claude-code/source.ts';
import { claudeProjects, loadConfig, miraHome } from './config.ts';
import { vscode } from './editor.ts';
import { GrowthTracker } from './growth.ts';
import { makeCostOf } from './pricing.ts';
import { Roster } from './roster.ts';
import { createHub } from './server.ts';
import { shapeRecorder } from './shapes.ts';
import type { SourceAdapter } from './sources.ts';
import { Store } from './store.ts';
import { makePlaceResolver } from './systems.ts';
import { Terminals } from './terminals.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const config = loadConfig();
const store = new Store(join(miraHome, 'mira.db'));
const placeFor = makePlaceResolver(config.systems);
const roster = new Roster({ workingMs: config.quiet.workingMinutes * 60 * 1000, idleMs: config.quiet.idleHours * HOUR });
const pidFile = join(miraHome, 'hub.pid');
const sources: SourceAdapter[] = [claudeCode({ projectsDir: claudeProjects, placeFor, costOf: makeCostOf(config.prices), inboxFile: join(miraHome, 'inboxes.json') })];

// Old events go once a day, keeping the per-turn token counts (decision 32).
function prune() {
  if (!config.keepDays) return;
  const removed = store.prune(new Date(Date.now() - config.keepDays * DAY).toISOString());
  if (removed) console.log(`Removed ${removed} events older than ${config.keepDays} days.`);
}
prune();
setInterval(prune, DAY).unref();

// Today's statuses from stored events, then sessions that ran while the hub was stopped.
const now = Date.now();
for (const event of store.since(new Date(now - DAY).toISOString())) if (event.type !== 'usage.reported') roster.apply(event);
for (const source of sources) {
  roster.seed(source.id, source.discover?.(now - config.activeHours * HOUR) ?? []);
  for (const event of source.catchUp?.(now - DAY) ?? []) store.add(event);
}
// Token totals for every session in view, including turns from before today.
for (const event of store.since(new Date(now - 30 * DAY).toISOString(), 'usage.reported')) roster.apply(event);

// Commits grow each project's buildings (decision 35): read from the repos its sessions worked in.
const growth = new GrowthTracker({
  systems: () => store.systems(new Date(Date.now() - 14 * DAY).toISOString()).map((s) => s.name),
  rootsFor: (system) => {
    const cwds = [...roster.snapshot().filter((s) => s.system === system && s.cwd).map((s) => s.cwd as string), ...store.folders(system)];
    return [...new Set(cwds.map((cwd) => placeFor(cwd)).filter((p) => p.system === system && p.root).map((p) => p.root as string))];
  },
  onChange: () => hub.announceSystems(),
});

const hub = createHub({
  store,
  roster,
  sources,
  placeFor,
  permissionWaitMs: config.permissionWaitSeconds * 1000,
  recordShape: config.recordShapes ? shapeRecorder(join(miraHome, 'recordings')) : undefined,
  onEvent: (event) => {
    console.log(describe(event));
    if (event.type === 'turn.ended') growth.refreshSoon(); // a turn often ends with a commit
  },
  growth,
  editor: vscode(),
  terminals: new Terminals({ home: miraHome }),
});

hub.server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is busy. If the hook recorder is still running, stop it with Ctrl+C and start the hub again.`
    : err.message);
  process.exit(1);
});

growth.start(2 * 60 * 1000);

hub.server.listen(config.port, '127.0.0.1', () => {
  writeFileSync(pidFile, String(process.pid)); // so `npm run hub:stop` can find a hub running in the background
  const sessions = roster.snapshot();
  console.log(`Mira hub on http://127.0.0.1:${config.port} · ${sessions.length} session${sessions.length === 1 ? '' : 's'} in view · data in ${miraHome}`);
});

function shutDown() {
  hub.close();
  store.close();
  rmSync(pidFile, { force: true });
  process.exit(0);
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

function describe(event: MiraEvent): string {
  const time = new Date(event.at).toTimeString().slice(0, 8);
  const who = event.actor.kind === 'subagent' ? `${event.system} › ${event.actor.name ?? 'subagent'}` : event.system;
  const cost = event.usage?.costUsd !== undefined ? `$${event.usage.costUsd.toFixed(2)}` : '';
  const detail = event.detail?.tool ?? event.detail?.notification ?? event.detail?.reason ?? event.detail?.decision ?? cost;
  return `${time}  ${who.padEnd(22)} ${event.type.padEnd(22)} ${detail}`;
}
