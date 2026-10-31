// Mira as a desktop app (decision 43): a window onto the hub that pins to the taskbar, instead of a
// browser tab. It starts the hub in the background when it isn't running, and leaves it running
// when the window closes. Everything the window shows comes from the hub, as in a browser.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { loadConfig, QUICK_REPLIES } from '../hub/src/config.ts';
import type { AppPart, AppUsage } from '../hub/src/footprint-report.ts';
import { badgePng } from './badge.ts';
import { asCard, createPopup, type PopupCard } from './popup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const CONTROL = join(REPO, 'hub', 'src', 'control.ts');
const ICON = join(HERE, 'icon.ico');
const APP_ID = 'Mira';
const VOID = '#0b0d1a';
const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);

let port = 4711;
let quick = QUICK_REPLIES;
try {
  ({ port, quickReplies: quick } = loadConfig());
} catch {
  // A config the hub can't read: it says why when it starts.
}
const HUB = `http://127.0.0.1:${port}`;

/** Sends the hub something on the pop-up's behalf (decision 57); resolves to why it failed, or null. */
async function toHub(path: string, body: unknown, gone: string): Promise<string | null> {
  try {
    const res = await fetch(`${HUB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (res.ok) return null;
    return res.status === 404 ? gone : (await res.text()) || `The hub couldn't do that (${res.status}).`;
  } catch {
    return "Mira's hub isn't answering.";
  }
}

async function answering(): Promise<boolean> {
  try {
    return (await fetch(`${HUB}/api/systems`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Starts the hub in the background, as `npm run hub:background` does, with the Node on my PATH; resolves to why not, if it can't. */
function startHub(): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn('node', ['--disable-warning=ExperimentalWarning', CONTROL, 'start'], { cwd: REPO, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    child.on('error', (err) => done(`Node couldn't be run to start it (${err.message}). Mira needs Node 24 on the PATH.`));
    child.on('exit', (code) => done(code === 0 ? null : said.trim() || `Starting it failed with exit code ${code}.`));
  });
}

// The pages the window shows before the hub's: starting it, or why it couldn't.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let mirling = '';
try {
  mirling = readFileSync(join(REPO, 'hub', 'web', 'favicon.svg')).toString('base64');
} catch {
  // No picture, then.
}
const page = (body: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Mira</title><style>
  body { margin: 0; height: 100vh; display: grid; place-content: center; justify-items: center; gap: 12px; background: ${VOID}; color: #ece8d9; font: 15px/1.5 "IBM Plex Sans", "Segoe UI", sans-serif; text-align: center; }
  img { width: 72px; margin-bottom: 6px; image-rendering: pixelated; } p { margin: 0; max-width: 34em; } .dim { color: #9c9dbb; font-size: 13px; white-space: pre-wrap; } code { font-family: "Cascadia Code", Consolas, Menlo, "DejaVu Sans Mono", monospace; }
</style></head><body>${mirling ? `<img src="data:image/svg+xml;base64,${mirling}" alt="">` : ''}${body}</body></html>`)}`;

// The window keeps its size and place between runs, if that place is still on a screen.
const stateFile = () => join(app.getPath('userData'), 'window.json');

function savedPlace(): { bounds: Partial<Rectangle>; maximized: boolean } {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8')) as Rectangle & { maximized?: boolean };
    const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    const area = screen.getDisplayMatching(bounds).workArea;
    const onScreen = bounds.x < area.x + area.width - 100 && bounds.x + bounds.width > area.x + 100 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 100;
    if (Object.values(bounds).every(Number.isFinite) && onScreen) return { bounds, maximized: Boolean(saved.maximized) };
  } catch {
    // First run, or a file that's no use: the default place.
  }
  return { bounds: { width: 1440, height: 900 }, maximized: false };
}

function savePlace(win: BrowserWindow): void {
  try {
    writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    // Not remembered this time.
  }
}

/** Shows the hub's page, starting the hub first if it isn't answering. */
async function connect(win: BrowserWindow): Promise<void> {
  if (!(await answering())) {
    void win.loadURL(page("<p>Starting Mira's hub…</p>"));
    const failed = await startHub();
    if (failed || !(await answering())) {
      void win.loadURL(page(`<p>Mira couldn't start its hub.</p><p class="dim">${esc(failed ?? "It started, but isn't answering.")}</p><p class="dim">Start it with <code>npm run hub:background</code> in the Mira folder, then press F5.</p>`));
      return;
    }
  }
  await win.loadURL(HUB);
}

function createWindow(): BrowserWindow {
  const { bounds, maximized } = savedPlace();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Mira',
    icon: ICON,
    backgroundColor: VOID,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: join(HERE, 'preload.cjs') },
  });
  if (maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => savePlace(win));

  // Pinned to the taskbar, Mira opens this app again, under its own name and icon.
  if (process.platform === 'win32') {
    win.setAppDetails({ appId: APP_ID, appIconPath: ICON, appIconIndex: 0, relaunchCommand: `"${process.execPath}" "${HERE}"`, relaunchDisplayName: 'Mira' });
  }

  // Only the hub's page shows here. Web links open in the browser and VS Code links in VS Code;
  // anything else goes nowhere.
  const outside = (url: string) => {
    if (/^(https?|vscode):/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    outside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${HUB}/`) || url === HUB) return;
    event.preventDefault();
    outside(url);
  });

  // The page's title counts the sessions calling for me, which the taskbar button wears as a red
  // badge (decision 55): over its corner on Windows, on the Dock icon on a Mac.
  win.on('page-title-updated', (_event, title) => {
    const count = Number(title.match(/^\((\d+)\)/)?.[1] ?? 0);
    if (process.platform === 'win32') win.setOverlayIcon(count ? nativeImage.createFromBuffer(badgePng(count), { scaleFactor: 2 }) : null, count ? `${count} waiting for you` : '');
    else app.setBadgeCount(count);
  });
  win.on('focus', () => win.flashFrame(false));

  // A notification clicked on the page brings the window forward (decision 45). Windows lets a
  // window that's on top take the focus, so it's put on top for the moment it takes it.
  const forward = () => {
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true);
    win.show();
    win.focus();
    win.setAlwaysOnTop(false);
  };
  const fromPage = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === win.webContents;
  for (const channel of ['mira:focus', 'mira:flash', 'mira:popup', 'mira:unpop']) ipcMain.removeAllListeners(channel);
  ipcMain.removeHandler('mira:update');
  ipcMain.removeHandler('mira:metrics');
  ipcMain.on('mira:focus', (event) => { if (fromPage(event)) forward(); });
  // When a session calls for me, the page flashes the taskbar button and puts up Mira's pop-up in the
  // middle of the screen (decision 55). Its cards answer the session from where I am (decision 57):
  // a reply, or Allow or Deny, goes to the hub from here, and the page hears what came of each card.
  const tell = (action: string, card: PopupCard) => { if (!win.isDestroyed()) win.webContents.send('mira:popup-action', action, card.id, card.session); };
  const after = (action: string, card: PopupCard) => (failed: string | null) => {
    if (!failed) tell(action, card);
    return failed;
  };
  const popup = createPopup(HERE, win, {
    quick,
    onAction: (action, card, value) => {
      if (action === 'editor') return void inEditor(card);
      // Claude Code won't type into a conversation that's open in VS Code, and nothing can type into
      // a window behind others, so the reply goes on the clipboard and the conversation comes forward.
      if (action === 'paste' && value) {
        clipboard.writeText(value);
        return toEditor(card).then((opened) => (opened ? after('pasted', card)(null) : "Mira can't find a VS Code window for this session. Your reply is copied, though."));
      }
      if (action === 'open') forward();
      if (action === 'open' || action === 'dismiss') return void tell(action, card);
      if (action === 'reply') {
        return toHub(`/api/sessions/${encodeURIComponent(card.session)}/message`, { text: value }, 'That session has gone. Carry it on in Mira or VS Code.').then(after('replied', card));
      }
      if (action === 'answer' && card.prompt) {
        return toHub(`/api/prompts/${encodeURIComponent(card.prompt.id)}`, { decision: value }, 'That prompt is no longer waiting for Mira. Answer it in the session.').then(after('answered', card));
      }
      if (action === 'tell' && card.clash) return toHub('/api/clashes/tell', { sessions: card.clash.sessions }, "Mira's hub can't tell them.").then(after('told', card));
      return Promise.resolve("That card can't do that.");
    },
  });
  // Open in VS Code does what the story's Continue in VS Code does: the link to its window brings
  // that window forward, then the hub opens the conversation in it. One with no VS Code window to go
  // to opens in Mira instead.
  async function inEditor(card: PopupCard) {
    if (await toEditor(card)) return tell('editor', card);
    if (win.isDestroyed()) return;
    forward();
    tell('open', card);
  }
  async function toEditor(card: PopupCard): Promise<boolean> {
    const at = `${HUB}/api/sessions/${encodeURIComponent(card.session)}/editor`;
    try {
      const res = await fetch(at, { signal: AbortSignal.timeout(3000) });
      const link = res.ok ? ((await res.json()) as { link?: unknown }).link : undefined;
      if (typeof link !== 'string' || !/^vscode:/i.test(link)) return false;
      await shell.openExternal(link);
      await fetch(at, { method: 'POST', signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false; // the hub isn't answering
    }
  }
  ipcMain.on('mira:flash', (event) => { if (fromPage(event) && !win.isFocused()) win.flashFrame(true); });
  // Taking an update (decision 60): the hub hands over to its updater, which waits for the hub and
  // this app to close, so the app closes too, and is opened again once the update is in.
  ipcMain.handle('mira:update', async (event) => {
    if (!fromPage(event)) return "Only Mira's page can update it.";
    const failed = await toHub('/api/update', { app: process.pid }, "This hub doesn't update itself.");
    if (!failed) setTimeout(() => app.quit(), 200);
    return failed;
  });
  // What the app's own processes cost the machine, for Settings (decision 61): the window's page, the
  // pop-up's, drawing on the graphics card, and the app itself with its helpers. Each call measures the
  // CPU used since the last, already as a share of the whole machine.
  ipcMain.handle('mira:metrics', (event): AppUsage | null => {
    if (!fromPage(event)) return null;
    const page = win.webContents.getOSProcessId();
    const parts = new Map<AppPart, { cpu: number; memory: number }>();
    for (const m of app.getAppMetrics()) {
      const part: AppPart = m.pid === page ? 'window' : m.type === 'Tab' ? 'popup' : m.type === 'GPU' ? 'graphics' : 'app';
      const sum = parts.get(part) ?? { cpu: 0, memory: 0 };
      sum.cpu += m.cpu.percentCPUUsage / 100;
      sum.memory += m.memory.workingSetSize * 1024;
      parts.set(part, sum);
    }
    return [...parts].map(([part, usage]) => ({ part, ...usage }));
  });
  ipcMain.on('mira:popup', (event, card: unknown) => {
    const valid = fromPage(event) ? asCard(card) : null;
    if (valid) popup.show(valid);
  });
  ipcMain.on('mira:unpop', (event, id: unknown) => { if (fromPage(event) && typeof id === 'string') popup.hide(id); });
  // A page loaded afresh starts with nothing showing; so does the app closing.
  win.webContents.on('did-navigate', () => popup.clear());
  win.on('closed', () => popup.close());

  // A few keys of a browser's, with no menu bar: F5 reloads, F11 is full screen, F12 the developer
  // tools, and Ctrl with plus, minus or 0 zooms. Every other key goes to the page and its terminal.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const contents = win.webContents;
    const act = (fn: () => void) => {
      event.preventDefault();
      fn();
    };
    if (input.key === 'F5') act(() => (contents.getURL().startsWith(HUB) ? contents.reload() : void connect(win)));
    else if (input.key === 'F11') act(() => win.setFullScreen(!win.isFullScreen()));
    else if (input.key === 'F12') act(() => contents.toggleDevTools());
    else if (ctrl && (input.key === '=' || input.key === '+')) act(() => contents.setZoomLevel(contents.getZoomLevel() + 0.5));
    else if (ctrl && input.key === '-') act(() => contents.setZoomLevel(contents.getZoomLevel() - 0.5));
    else if (ctrl && input.key === '0') act(() => contents.setZoomLevel(0));
  });

  void connect(win);
  return win;
}

/**
 * Windows shows an app's notifications under the name and icon of the Start menu shortcut that
 * carries its ID, and drops them without one (decision 45). So the app keeps one: Mira in the Start
 * menu, opening it as the pinned button does, rewritten only when the app has moved.
 */
function startMenuShortcut(): void {
  if (process.platform !== 'win32') return;
  const link = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Mira.lnk');
  const want = { target: process.execPath, args: `"${HERE}"`, cwd: REPO, icon: ICON, iconIndex: 0, appUserModelId: APP_ID, description: 'Mira, the dashboard for my agents' };
  try {
    const have = shell.readShortcutLink(link);
    if (have.target === want.target && have.args === want.args && have.icon === want.icon && have.appUserModelId === APP_ID) return;
  } catch {
    // None yet.
  }
  if (!shell.writeShortcutLink(link, 'create', want)) console.warn(`Mira couldn't write its Start menu shortcut at ${link}, so Windows may not show its notifications.`);
}

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) {
  app.quit(); // Mira is open already: the first one comes forward instead
} else {
  let win: BrowserWindow | null = null;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => done(ALLOWED.has(permission)));
    startMenuShortcut();
    win = createWindow();
  });
}
