// Mira updates itself from the repo it was cloned from (decision 60). The hub checks every few hours
// whether the branch it runs has new commits upstream, and the page offers to take them. Only a copy
// with no changes or commits of its own is ever updated, and only by fast-forwarding, so a copy
// someone is working in is left alone. Taking the update runs in a process of its own (updater.ts),
// since it restarts the hub.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateOutcome, UpdateStatus } from './update-status.ts';

export type { UpdateOutcome, UpdateStatus };

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
const UPDATER = fileURLToPath(new URL('./updater.ts', import.meta.url));
/** What changes whenever Mira's packages do, so they're installed again; a new script alone doesn't count. */
export const PACKAGE_FILES = ['package-lock.json'];
const GIT_MS = 15_000;
const FETCH_MS = 60_000;
const MAX_CHANGES = 20;
const MAX_SAID = 400;
const MAX_LOG = 1024 * 1024;
// Long enough for the page to hear that the update has started before the hub closes.
const EXIT_AFTER_MS = 500;

/** Runs git in a folder; resolves to what it printed, or rejects with its complaint, on one line. */
export type Git = (args: string[], timeoutMs?: number) => Promise<string>;

export function gitIn(repo: string): Git {
  return (args, timeoutMs = GIT_MS) => new Promise((done, fail) => {
    // Never wait on a password: a check that would need one just fails.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd: repo, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // All of it, since git often names the files in the way on the lines after the first.
      const said = String(stderr).split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
      if (err) fail(new Error(said.slice(0, MAX_SAID) || err.message));
      else done(String(stdout).trim());
    });
  });
}

/** Where the copy stands against its upstream, fetching first when asked. */
export async function inspect(git: Git, options: { fetch: boolean }): Promise<UpdateStatus> {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { state: 'unknown', reason: "This copy of Mira isn't a git clone, so it can't update itself." };
  }
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (!branch) return { state: 'blocked', reason: "This copy isn't on a branch, so Mira doesn't know where its updates come from." };
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
  if (!upstream) return { state: 'blocked', reason: `The ${branch} branch doesn't track an upstream branch, so Mira doesn't know where its updates come from.` };
  if (options.fetch) {
    try {
      await git(['fetch', '--quiet', '--no-tags'], FETCH_MS);
    } catch (err) {
      return { state: 'unknown', upstream, reason: `Mira couldn't reach ${upstream}: ${(err as Error).message}` };
    }
  }
  const [ahead = 0, behind = 0] = (await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).split(/\s+/).map(Number);
  if (!behind) return { state: 'current', upstream, behind: 0 };
  const changes = (await git(['log', '--format=%h%x1f%s', `-n${MAX_CHANGES}`, 'HEAD..@{u}']))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = ''] = line.split('\x1f');
      return { hash, subject };
    });
  const packages = Boolean(await git(['diff', '--name-only', 'HEAD', '@{u}', '--', ...PACKAGE_FILES]));
  const found: UpdateStatus = { state: 'available', upstream, behind, changes, ...(packages ? { packages } : {}) };
  if (ahead) return { ...found, state: 'blocked', reason: `This copy has ${ahead} commit${ahead === 1 ? '' : 's'} that ${upstream} hasn't, so Mira leaves the update for you to pull.` };
  if (await git(['status', '--porcelain', '--untracked-files=no'])) return { ...found, state: 'blocked', reason: 'This copy has changes of its own, so Mira leaves the update for you to pull.' };
  return found;
}

/** How the last update went, as the updater left it in the Mira home. */
export function lastOutcome(home: string): UpdateOutcome | undefined {
  try {
    return JSON.parse(readFileSync(join(home, 'update.json'), 'utf8')) as UpdateOutcome;
  } catch {
    return undefined;
  }
}

export interface UpdatesOptions {
  home: string;
  repo?: string;
  git?: Git;
  /** The status changed: a check finished, or an update started. */
  onChange?(status: UpdateStatus): void;
  /** Closes the hub, once an update has started, so the updater can restart it. */
  exit(): void;
  /** Starts the updater; by default node runs updater.ts in the background, logging to update.log. */
  launch?(args: string[]): void;
}

/** The hub's side of updating: checking now and then, and handing over to the updater. */
export class Updates {
  #options: UpdatesOptions;
  #git: Git;
  #status: UpdateStatus;
  #checking: Promise<UpdateStatus> | null = null;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: UpdatesOptions) {
    this.#options = options;
    const repo = options.repo ?? REPO;
    this.#git = options.git ?? gitIn(repo);
    let running: string | undefined;
    try {
      running = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch {
      // Not a git clone: the check says so.
    }
    const last = lastOutcome(options.home);
    this.#status = { state: 'unknown', ...(running ? { running } : {}), ...(last ? { last } : {}) };
  }

  status(): UpdateStatus {
    return this.#status;
  }

  /** Checks now, fetching from upstream unless told not to; a check already going is shared. */
  check(fetch = true): Promise<UpdateStatus> {
    this.#checking ??= inspect(this.#git, { fetch })
      .catch((err: Error): UpdateStatus => ({ state: 'unknown', reason: `Mira couldn't check for updates: ${err.message}` }))
      .then((found) => {
        const { running, last, updating } = this.#status;
        // Checked means fetched; a look at what was fetched before keeps the time of that fetch.
        const checkedAt = fetch ? new Date().toISOString() : this.#status.checkedAt;
        this.#status = { ...found, ...(running ? { running } : {}), ...(last ? { last } : {}), ...(updating ? { updating } : {}), ...(checkedAt ? { checkedAt } : {}) };
        this.#options.onChange?.(this.#status);
        return this.#status;
      })
      .finally(() => { this.#checking = null; });
    return this.#checking;
  }

  /** Checks a minute after starting, then every so often. */
  start(everyMs: number, firstMs = 60_000): void {
    const first = setTimeout(() => void this.check(), firstMs);
    first.unref();
    this.#timer = setInterval(() => void this.check(), everyMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /**
   * Hands over to the updater, which waits for the hub (and the app, when it gives its process) to
   * close, then takes the update and starts them again. Resolves to why it can't, or null.
   */
  async apply(app?: number): Promise<string | null> {
    if (this.#status.updating) return 'Mira is already updating.';
    const status = await this.check(false);
    if (status.state !== 'available') return status.reason ?? 'Mira is up to date.';
    const waitFor = [process.pid, ...(app ? [app] : [])];
    const args = ['--after', waitFor.join(','), ...(app ? ['--app'] : [])];
    try {
      (this.#options.launch ?? launchUpdater(this.#options.home, this.#options.repo ?? REPO))(args);
    } catch (err) {
      return `Mira couldn't start its updater: ${(err as Error).message}`;
    }
    this.#status = { ...this.#status, updating: true };
    this.#options.onChange?.(this.#status);
    setTimeout(() => this.#options.exit(), EXIT_AFTER_MS).unref();
    return null;
  }
}

function launchUpdater(home: string, repo: string): (args: string[]) => void {
  return (args) => {
    const file = join(home, 'update.log');
    if (existsSync(file) && statSync(file).size > MAX_LOG) renameSync(file, `${file}.1`);
    const log = openSync(file, 'a');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', UPDATER, ...args], { cwd: repo, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.unref();
  };
}
