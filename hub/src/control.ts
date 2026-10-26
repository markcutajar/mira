// Keeps the hub running without a terminal (decision 34): start it in the background, stop or
// restart it, and start it at login. `npm start` still runs it in a terminal, with its log there.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, miraHome } from './config.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const LOG = join(miraHome, 'hub.log');
const PID = join(miraHome, 'hub.pid');
const MAX_LOG = 5 * 1024 * 1024;
const config = loadConfig();
const url = `http://127.0.0.1:${config.port}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function answering(): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/systems`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(up: boolean): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if ((await answering()) === up) return true;
    await sleep(250);
  }
  return false;
}

function pid(): number | null {
  try {
    const n = Number(readFileSync(PID, 'utf8'));
    process.kill(n, 0); // throws if no such process
    return n;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  if (await answering()) return console.log(`The hub is already running at ${url}.`);
  mkdirSync(miraHome, { recursive: true });
  if (existsSync(LOG) && statSync(LOG).size > MAX_LOG) renameSync(LOG, `${LOG}.1`);
  const log = openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], { cwd: REPO, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref();
  if (await waitFor(true)) console.log(`The hub is running at ${url}, logging to ${LOG}.`);
  else {
    console.error(`The hub didn't come up. Its log is ${LOG}.`);
    process.exitCode = 1;
  }
}

async function stop(): Promise<void> {
  const running = pid();
  if (!running) {
    console.log((await answering()) ? `A hub is answering at ${url}, but it wasn't started in the background. Stop it where it runs.` : "The hub isn't running.");
    return;
  }
  process.kill(running);
  rmSync(PID, { force: true });
  console.log((await waitFor(false)) ? 'The hub has stopped.' : `The hub was asked to stop but still answers at ${url}.`);
}

async function status(): Promise<void> {
  const up = await answering();
  const running = pid();
  console.log(up ? `The hub is running at ${url}${running ? ` in the background (process ${running}), logging to ${LOG}` : ', in a terminal'}.` : "The hub isn't running.");
  console.log(existsSync(startupFile()) ? 'It starts at login.' : "It doesn't start at login. Turn that on with: npm run hub:login");
}

// A one-line script in the Windows Startup folder needs no admin rights; at login it starts the
// hub in the background and closes, so a console window flashes up for a moment.
function startupFile(): string {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Mira hub.cmd');
}

export function startupScript(node: string, control: string): string {
  return `@echo off\r\nrem Starts the Mira hub in the background at login. Turn off with: npm run hub:login-off\r\n"${node}" --disable-warning=ExperimentalWarning "${control}" start\r\n`;
}

function login(on: boolean): void {
  if (process.platform !== 'win32') {
    console.error('Starting at login is only set up for Windows so far.');
    process.exitCode = 1;
    return;
  }
  const file = startupFile();
  if (on) {
    writeFileSync(file, startupScript(process.execPath, SELF));
    console.log(`The hub will start at login, from ${file}.`);
  } else {
    rmSync(file, { force: true });
    console.log("The hub won't start at login any more.");
  }
}

const COMMANDS: Record<string, () => unknown> = {
  start,
  stop,
  restart: async () => { await stop(); await start(); },
  status,
  login: () => login(true),
  'login-off': () => login(false),
};

// Run as a command, not when a test imports it. Windows may spell the drive letter either way.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  const command = COMMANDS[process.argv[2] ?? ''];
  if (command) await command();
  else console.error(`Use one of: ${Object.keys(COMMANDS).join(', ')}.`);
}
