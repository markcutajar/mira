// Mira as a desktop app (decision 43): a window onto the hub that pins to the taskbar, instead of a
// browser tab. It starts the hub in the background when it isn't running, and leaves it running
// when the window closes. Everything the window shows comes from the hub, as in a browser.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, screen, session, shell, type Rectangle } from 'electron';
import { loadConfig } from '../hub/src/config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const CONTROL = join(REPO, 'hub', 'src', 'control.ts');
const ICON = join(HERE, 'icon.ico');
const APP_ID = 'Mira';
const VOID = '#0b0d1a';
const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

let port = 4711;
try {
  port = loadConfig().port;
} catch {
  // A config the hub can't read: it says why when it starts.
}
const HUB = `http://127.0.0.1:${port}`;

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
  img { width: 72px; margin-bottom: 6px; image-rendering: pixelated; } p { margin: 0; max-width: 34em; } .dim { color: #9c9dbb; font-size: 13px; white-space: pre-wrap; } code { font-family: "Cascadia Code", Consolas, monospace; }
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
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

  // When a prompt starts waiting for me, the page's title gains a count: the taskbar button flashes.
  win.on('page-title-updated', (_event, title) => {
    if (/^\(\d+\)/.test(title) && !win.isFocused()) win.flashFrame(true);
  });
  win.on('focus', () => win.flashFrame(false));

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
    win = createWindow();
  });
}
