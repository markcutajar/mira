// Starts the hub: rebuilds the live picture from storage and each source, then listens.

import { join } from 'node:path';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { claudeCode } from './claude-code/source.ts';
import { Colony } from './colony.ts';
import { claudeProjects, loadConfig, miraHome } from './config.ts';
import { vscode } from './editor.ts';
import { makeCostOf } from './pricing.ts';
import { createHub } from './server.ts';
import { shapeRecorder } from './shapes.ts';
import type { SourceAdapter } from './sources.ts';
import { Store } from './store.ts';
import { makePlaceResolver } from './systems.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const config = loadConfig();
const store = new Store(join(miraHome, 'mira.db'));
const placeFor = makePlaceResolver(config.systems);
const colony = new Colony();
const sources: SourceAdapter[] = [claudeCode({ projectsDir: claudeProjects, placeFor, costOf: makeCostOf(config.prices) })];

// Today's statuses from stored events, then sessions that ran while the hub was stopped.
const now = Date.now();
for (const event of store.since(new Date(now - DAY).toISOString())) if (event.type !== 'usage.reported') colony.apply(event);
for (const source of sources) {
  colony.seed(source.id, source.discover?.(now - config.activeHours * HOUR) ?? []);
  for (const event of source.catchUp?.(now - DAY) ?? []) store.add(event);
}
// Token totals for every session in view, including turns from before today.
for (const event of store.since(new Date(now - 30 * DAY).toISOString(), 'usage.reported')) colony.apply(event);

const hub = createHub({
  store,
  colony,
  sources,
  placeFor,
  permissionWaitMs: config.permissionWaitSeconds * 1000,
  recordShape: config.recordShapes ? shapeRecorder(join(miraHome, 'recordings')) : undefined,
  onEvent: (event) => console.log(describe(event)),
  editor: vscode(),
});

hub.server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is busy. If the hook recorder is still running, stop it with Ctrl+C and start the hub again.`
    : err.message);
  process.exit(1);
});

hub.server.listen(config.port, '127.0.0.1', () => {
  const sessions = colony.snapshot();
  console.log(`Mira hub on http://127.0.0.1:${config.port} · ${sessions.length} session${sessions.length === 1 ? '' : 's'} in view · data in ${miraHome}`);
});

process.on('SIGINT', () => {
  hub.close();
  store.close();
  process.exit(0);
});

function describe(event: MiraEvent): string {
  const time = new Date(event.at).toTimeString().slice(0, 8);
  const who = event.actor.kind === 'subagent' ? `${event.system} › ${event.actor.name ?? 'subagent'}` : event.system;
  const cost = event.usage?.costUsd !== undefined ? `$${event.usage.costUsd.toFixed(2)}` : '';
  const detail = event.detail?.tool ?? event.detail?.notification ?? event.detail?.reason ?? event.detail?.decision ?? cost;
  return `${time}  ${who.padEnd(22)} ${event.type.padEnd(22)} ${detail}`;
}
