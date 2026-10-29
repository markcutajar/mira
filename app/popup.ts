// Mira's own pop-up (decision 55). Windows puts its notifications in the far corner of the screen,
// easy to miss on a wide one, and no app can move them, so the app also shows its own, in the middle
// of the screen Mira is on. Showing it never takes the keyboard: whatever I'm typing in carries on
// until I click it. Each session gets a card, newest on top; its buttons open the session in Mira or
// in VS Code, or close the card, and a "done" card fades by itself after a few seconds.

import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';

/** One session's card: what happened, such as "Pip needs you", the session's name, and where. */
export interface PopupCard {
  id: string;
  status: 'needs-me' | 'failed' | 'my-turn';
  title: string;
  task?: string;
  body: string;
}
export type PopupAction = 'open' | 'editor' | 'dismiss';

const WIDTH = 480; // the cards, and room around them for their shadow
const MOST = 4;
const STATUSES = new Set(['needs-me', 'failed', 'my-turn']);
const ACTIONS = new Set(['open', 'editor', 'dismiss', 'expire']);

/** A card as the page sent it, if it's one. */
export function asCard(value: unknown): PopupCard | null {
  const c = value as Partial<PopupCard> | null;
  const text = (s: unknown, most: number) => typeof s === 'string' && s.length > 0 && s.length <= most;
  if (!c || !text(c.id, 100) || !STATUSES.has(c.status as string) || !text(c.title, 300) || !text(c.body, 300)) return null;
  if (c.task !== undefined && !text(c.task, 300)) return null;
  return { id: c.id as string, status: c.status as PopupCard['status'], title: c.title as string, ...(c.task ? { task: c.task } : {}), body: c.body as string };
}

export function createPopup(here: string, owner: BrowserWindow, onAction: (action: PopupAction, id: string) => void) {
  let win: BrowserWindow | null = null;
  let cards: PopupCard[] = [];
  let height = 0;

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    const popup = new BrowserWindow({
      width: WIDTH,
      height: 160,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Windows throws away every click on a window that can't take the focus. It's shown without
      // it, so it only takes the keyboard when I click it.
      focusable: true,
      alwaysOnTop: true,
      // On Windows, a tool window: no taskbar button or Alt+Tab entry, and window snappers such as
      // FancyZones leave it where it's put instead of moving it into a zone.
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      title: 'Mira',
      // Not throttled while hidden, so it measures its cards before it first shows.
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, preload: join(here, 'popup-preload.cjs') },
    });
    popup.setAlwaysOnTop(true, 'screen-saver'); // above full-screen windows too
    if (process.platform === 'darwin') popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.webContents.on('did-finish-load', send);
    void popup.loadFile(join(here, 'popup.html'));
    win = popup;
    return popup;
  }

  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('popup:cards', cards); };

  // The middle of the screen Mira's window is on, or was on before it was minimised.
  function place() {
    if (!win || win.isDestroyed() || !cards.length || !height) return;
    const area = (owner.isDestroyed() ? screen.getPrimaryDisplay() : screen.getDisplayMatching(owner.getNormalBounds())).workArea;
    const tall = Math.min(height, area.height);
    win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + (area.height - tall) / 2), width: WIDTH, height: tall });
    if (!win.isVisible()) win.showInactive();
  }

  function remove(id: string) {
    cards = cards.filter((c) => c.id !== id);
    if (!cards.length) {
      height = 0;
      if (win && !win.isDestroyed()) win.hide();
    }
    send();
  }

  const fromPopup = (event: IpcMainEvent) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  const sized = (event: IpcMainEvent, tall: unknown) => {
    if (!fromPopup(event) || typeof tall !== 'number' || !Number.isFinite(tall)) return;
    height = Math.max(0, Math.min(2000, Math.ceil(tall)));
    place();
  };
  const acted = (event: IpcMainEvent, action: unknown, id: unknown) => {
    if (!fromPopup(event) || typeof id !== 'string' || !ACTIONS.has(action as string) || !cards.some((c) => c.id === id)) return;
    remove(id);
    if (action !== 'expire') onAction(action as PopupAction, id);
  };
  ipcMain.on('popup:size', sized);
  ipcMain.on('popup:act', acted);

  return {
    /** Puts up a session's card, or brings its card up to date and to the top. */
    show(card: PopupCard) {
      cards = [card, ...cards.filter((c) => c.id !== card.id)].slice(0, MOST);
      ensure();
      send();
    },
    /** Takes a session's card down, when what it said is no longer true or I've read it. */
    hide(id: string) {
      if (cards.some((c) => c.id === id)) remove(id);
    },
    clear() {
      cards = [];
      height = 0;
      if (win && !win.isDestroyed()) win.hide();
      send();
    },
    close() {
      ipcMain.removeListener('popup:size', sized);
      ipcMain.removeListener('popup:act', acted);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
