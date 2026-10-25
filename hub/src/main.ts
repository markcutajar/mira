// Starts the hub: rebuilds the live picture from storage and transcripts, then listens for hooks.

import { join } from 'node:path';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { activeSessions } from './claude-code/transcripts.ts';
import { Colony } from './colony.ts';
import { claudeProjects, loadConfig, miraHome } from './config.ts';
import { createHub } from './server.ts';
import { shapeRecorder } from './shapes.ts';
import { Store } from './store.ts';
import { makeSystemResolver } from './systems.ts';

const HOUR = 60 * 60 * 1000;

const config = loadConfig();
const store = new Store(join(miraHome, 'mira.db'));
const systemFor = makeSystemResolver(config.systems);
const colony = new Colony();

// Today's stored events first, then sessions that ran while the hub was stopped.
for (const event of store.since(new Date(Date.now() - 24 * HOUR).toISOString())) colony.apply(event);
const running = activeSessions(claudeProjects, Date.now() - config.activeHours * HOUR);
colony.seed(running.map((s) => ({ ...s, system: systemFor(s.cwd) })));

const hub = createHub({
  store,
  colony,
  systemFor,
  permissionWaitMs: config.permissionWaitSeconds * 1000,
  recordShape: config.recordShapes ? shapeRecorder(join(miraHome, 'recordings')) : undefined,
  onEvent: (event) => console.log(describe(event)),
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
  const detail = event.detail?.tool ?? event.detail?.notification ?? event.detail?.reason ?? event.detail?.decision ?? '';
  return `${time}  ${who.padEnd(22)} ${event.type.padEnd(22)} ${detail}`;
}
