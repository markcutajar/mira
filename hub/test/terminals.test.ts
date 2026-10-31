import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hostFile } from '../src/terminal-protocol.ts';
import { runningTerminals, stopTerminalHost, terminalUsage } from '../src/terminals.ts';

const WAITS = "process.stdout.write('ready'); process.stdin.on('data', () => process.exit(0))";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('terminal host', () => {
  const home = mkdtempSync(join(tmpdir(), 'mira-terminals-'));
  after(async () => {
    await stopTerminalHost(home);
    rmSync(home, { recursive: true, force: true });
  });

  it('runs as a process of its own, outlives the hub that started it, and ends when stopped', async () => {
    // A stand-in hub in a process of its own: it opens a terminal, starts a program in it, and quits
    // once the program is running.
    const hub = `
      import { EventEmitter } from 'node:events';
      import { Terminals } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/terminals.ts')).href)};
      const page = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, close() {}, send(text) { if (text.includes('ready')) process.exit(0); } });
      new Terminals({ home: process.env.MIRA_HOME }).attach('s-1', page, { file: process.execPath, args: ['-e', ${JSON.stringify(WAITS)}], cwd: process.cwd(), title: 'waits' }, { cols: 80, rows: 24 });
      page.emit('message', JSON.stringify({ type: 'start' }));
      setTimeout(() => process.exit(1), 15000);
    `;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', hub], { env: { ...process.env, MIRA_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const code = await new Promise((done) => child.on('exit', done));
    assert.equal(code, 0, errors);

    assert.deepEqual(await runningTerminals(home), ['s-1']);
    const measured = await terminalUsage(home);
    assert.equal(measured?.running, 1);
    assert.ok((measured?.usage?.cpu ?? -1) >= 0 && (measured?.usage?.memory ?? 0) > 1e6);
    const { pid } = JSON.parse(readFileSync(hostFile(home), 'utf8')) as { pid: number };
    assert.equal(await stopTerminalHost(home), 1);
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false);
    assert.equal(await runningTerminals(home), null);
    assert.equal(await terminalUsage(home), null);
  });
});
