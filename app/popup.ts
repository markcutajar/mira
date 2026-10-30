// Mira's own pop-up (decisions 55 and 57). Windows puts its notifications in the far corner of the
// screen, easy to miss on a wide one, and no app can move them, so the app also shows its own, in the
// middle of the screen Mira is on. Showing it never takes the keyboard: whatever I'm typing in carries
// on until I click it. Each session gets a card, newest on top, which stays until I deal with it. The
// newest is open: a finished turn's card shows the session's last reply with a box to answer it, a
// permission prompt's shows what it would run with Allow and Deny, and a clash's names the files two
// sessions are both editing. Every card opens its session in Mira or in VS Code, or closes.

import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, shell, type IpcMainEvent } from 'electron';

/** One card: what happened, such as "Pip is done", the session's name, where, and what it said or asks. */
export interface PopupCard {
  /** The card's own key: its session's ID, or for a clash, the pair's. */
  id: string;
  /** The session it opens, reads and answers. */
  session: string;
  status: 'needs-me' | 'failed' | 'my-turn' | 'clash';
  title: string;
  task?: string;
  body: string;
  /** The session's last reply, in Markdown, read from its transcript as the card went up and never kept. */
  reply?: string;
  /** True when a reply can be sent from the card. */
  canReply?: boolean;
  /** True when the session runs in Mira's own terminal, where a reply is typed in as mine; elsewhere it goes from Mira, through its inbox. */
  inTerminal?: boolean;
  /** The permission prompt it asks, while Mira can still answer it, and what it would run. */
  prompt?: { id: string; summary?: string };
  /** Two sessions editing the same files (decision 58): the pair, and those files. */
  clash?: { sessions: [string, string]; files: string[] };
}
/** What a click on a card asks for. `reply`, `paste`, `answer` and `tell` resolve to why they failed, or null once done. */
export type PopupAction = 'open' | 'editor' | 'dismiss' | 'reply' | 'paste' | 'answer' | 'tell';

const WIDTH = 600; // the cards, and room around them for their shadow
const MOST = 6;
const STATUSES = new Set(['needs-me', 'failed', 'my-turn', 'clash']);
const ACTIONS = new Set(['open', 'editor', 'dismiss', 'reply', 'paste', 'answer', 'tell']);
// These go to the hub and back before the card goes, so a failure can be shown on it.
const ASKS = new Set(['reply', 'paste', 'answer', 'tell']);
const MAX_REPLY = 25_000;

const text = (s: unknown, most: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= most;

/** A card as the page sent it, if it's one. */
export function asCard(value: unknown): PopupCard | null {
  const c = value as Partial<PopupCard> | null;
  if (!c || !text(c.id, 100) || !STATUSES.has(c.status as string) || !text(c.title, 300) || !text(c.body, 300)) return null;
  const session = c.session === undefined ? c.id : c.session;
  if (!text(session, 100) || (c.task !== undefined && !text(c.task, 300)) || (c.reply !== undefined && !text(c.reply, MAX_REPLY))) return null;
  const prompt = c.prompt && text(c.prompt.id, 100) && (c.prompt.summary === undefined || text(c.prompt.summary, 600)) ? { id: c.prompt.id, ...(c.prompt.summary ? { summary: c.prompt.summary } : {}) } : undefined;
  const pair = c.clash?.sessions;
  const files = c.clash?.files;
  const clash = Array.isArray(pair) && pair.length === 2 && pair.every((s) => text(s, 100)) && Array.isArray(files) && files.length <= 10 && files.every((f) => text(f, 1024))
    ? { sessions: [pair[0], pair[1]] as [string, string], files: [...files] }
    : undefined;
  return {
    id: c.id,
    session,
    status: c.status as PopupCard['status'],
    title: c.title,
    body: c.body,
    ...(c.task ? { task: c.task } : {}),
    ...(c.reply ? { reply: c.reply } : {}),
    ...(c.canReply === true ? { canReply: true } : {}),
    ...(c.inTerminal === true ? { inTerminal: true } : {}),
    ...(prompt ? { prompt } : {}),
    ...(clash ? { clash } : {}),
  };
}

export interface PopupOptions {
  /** The quick replies offered under the box, from the config. */
  quick: string[];
  onAction(action: PopupAction, card: PopupCard, value?: string): void | Promise<string | null>;
}

export function createPopup(here: string, owner: BrowserWindow, options: PopupOptions) {
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
    // A web link in a reply opens in the browser; nothing else leaves the pop-up.
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.webContents.on('did-finish-load', send);
    void popup.loadFile(join(here, 'popup.html'));
    win = popup;
    return popup;
  }

  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('popup:cards', cards, options.quick); };
  const say = (id: string, said: string) => { if (win && !win.isDestroyed()) win.webContents.send('popup:said', id, said); };

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
    height = Math.max(0, Math.min(4000, Math.ceil(tall)));
    place();
  };
  const acted = (event: IpcMainEvent, action: unknown, id: unknown, value: unknown) => {
    const card = cards.find((c) => c.id === id);
    if (!fromPopup(event) || !card || !ACTIONS.has(action as string)) return;
    if (!ASKS.has(action as string)) {
      remove(card.id);
      return void options.onAction(action as PopupAction, card);
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 20_000) return;
    void Promise.resolve(options.onAction(action as PopupAction, card, value))
      .catch(() => "Mira's hub isn't answering.")
      .then((failed) => (failed ? say(card.id, failed) : remove(card.id)));
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
    /** Takes a card down, when what it said is no longer true or I've read it. */
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
