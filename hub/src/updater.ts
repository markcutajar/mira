// Takes Mira's update (decision 60). It runs in a process of its own, because it restarts the hub: it
// waits for the hub, and the app when the app asked for the update, to close; fast-forwards the copy
// to its upstream; installs the packages again if they changed, ending the terminals first, since
// they hold the packages' native code; then starts the hub in the background and opens the app again.
// Run by hand, as `npm run update`, it restarts a hub that was running in the background.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { miraHome } from './config.ts';
import { stopTerminalHost } from './terminals.ts';
import { gitIn, inspect, PACKAGE_FILES, REPO, type Git, type UpdateOutcome } from './updates.ts';

const SELF = fileURLToPath(import.meta.url);
const CONTROL = fileURLToPath(new URL('./control.ts', import.meta.url));
const WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface UpdateSteps {
  git: Git;
  /** Installs the packages the copy now names. */
  install(): Promise<void>;
  /** Ends the terminal host, whose terminals hold the packages' native code. */
  stopTerminals(): Promise<unknown>;
  say(line: string): void;
}

/** Fast-forwards the copy to its upstream, installing packages again when they changed. Never throws. */
export async function takeUpdate(steps: UpdateSteps): Promise<UpdateOutcome> {
  const { git, say } = steps;
  const outcome = (ok: boolean, from: string, to: string, error?: string): UpdateOutcome => ({ at: new Date().toISOString(), ok, from, to, ...(error ? { error } : {}) });
  let from = '';
  try {
    from = await git(['rev-parse', 'HEAD']);
    await git(['fetch', '--quiet', '--no-tags'], 60_000).catch((err: Error) => say(`Couldn't fetch, so taking what was fetched before: ${err.message}`));
    const status = await inspect(git, { fetch: false });
    if (status.state === 'current') return outcome(true, from, from);
    if (status.state !== 'available') return outcome(false, from, from, status.reason ?? "Mira can't update this copy.");
    await git(['merge', '--ff-only', '--quiet', '@{u}']);
    const to = await git(['rev-parse', 'HEAD']);
    say(`Updated from ${from.slice(0, 7)} to ${to.slice(0, 7)}.`);
    if (!(await git(['diff', '--name-only', from, to, '--', ...PACKAGE_FILES]))) return outcome(true, from, to);
    say('Its packages changed: ending the terminals and installing them.');
    await steps.stopTerminals();
    try {
      await steps.install();
    } catch (err) {
      say(`Installing failed, so going back to ${from.slice(0, 7)}: ${(err as Error).message}`);
      await git(['reset', '--keep', from]);
      await steps.install().catch((again: Error) => say(`Installing the old packages again failed too: ${again.message}`));
      return outcome(false, from, from, `Mira couldn't install its new packages, so it stayed as it was: ${(err as Error).message}`);
    }
    return outcome(true, from, to);
  } catch (err) {
    const now = await git(['rev-parse', 'HEAD']).catch(() => from);
    return outcome(false, from, now, (err as Error).message);
  }
}

/** Resolves once the process has gone, or false if it's still there after a while. */
async function gone(pid: number, ms = WAIT_MS): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0); // throws once there's no such process
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return true;
    }
    await sleep(200);
  }
  return false;
}

/** npm install, with the npm that ran this when there was one. */
function install(): Promise<void> {
  const args = ['install', '--no-audit', '--no-fund'];
  const npm = process.env.npm_execpath;
  const child = npm
    ? spawn(process.execPath, [npm, ...args], { cwd: REPO, stdio: 'inherit', windowsHide: true })
    : spawn('npm', args, { cwd: REPO, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`npm install stopped with code ${code}.`))));
  });
}

function control(command: string): Promise<void> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CONTROL, command], { cwd: REPO, stdio: 'inherit', windowsHide: true });
  return new Promise((done) => child.on('exit', () => done()));
}

/** Opens Mira's app again, with the Electron the copy now has. */
function openApp(): void {
  try {
    const electron = createRequire(join(REPO, 'package.json'))('electron') as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(electron, [join(REPO, 'app')], { cwd: REPO, env, detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.log(`Couldn't open the app again (${(err as Error).message}). Open it from the taskbar.`);
  }
}

async function hubAnswers(): Promise<boolean> {
  const { answering } = await import('./control.ts');
  return answering();
}

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--after');
  const after = at >= 0 ? (argv[at + 1] ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const app = argv.includes('--app');
  console.log(`${new Date().toISOString()} Updating Mira in ${REPO}`);
  // Asked by the hub: it, and the app if it asked, are closing for this.
  for (const pid of after) if (!(await gone(pid))) console.log(`Process ${pid} hasn't closed; carrying on anyway.`);
  const wasUp = after.length ? true : await hubAnswers();
  const outcome = await takeUpdate({ git: gitIn(REPO), install, stopTerminals: () => stopTerminalHost(miraHome), say: (line) => console.log(line) });
  mkdirSync(miraHome, { recursive: true });
  writeFileSync(join(miraHome, 'update.json'), JSON.stringify(outcome));
  if (!outcome.ok) console.log(`Not updated: ${outcome.error}`);
  else if (outcome.from === outcome.to) console.log('Mira is up to date.');
  // The hub closed for this, so it starts again whatever happened; by hand, one running restarts.
  if (after.length) await control('start');
  else if (wasUp && outcome.from !== outcome.to) await control('restart');
  if (app) openApp();
}

// Run as a command, not when a test imports it. Windows may spell the drive letter either way.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) await main(process.argv.slice(2));
