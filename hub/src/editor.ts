// Carrying a session on in VS Code. VS Code sends a link to the window used last, so to land in
// the right one the board first opens the workspace (or folder) that holds the session, and the
// hub then opens the session's own link. Which workspace holds which folder comes from VS Code's
// record of its open windows, an internal file that may change, so anything unexpected falls back
// to the session's folder.

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EditorTarget {
  /** A `vscode://file/` link to the workspace file or folder to bring forward. */
  link: string;
  /** What VS Code calls that window, e.g. `mira (Workspace)`. */
  name: string;
}

export interface Editor {
  target(folder: string): EditorTarget | null;
  open(link: string): void;
}

export function vscode(stateFile = defaultStateFile()): Editor {
  return { target: (folder) => vscodeTarget(folder, stateFile), open: openLink };
}

/** The open window whose workspace holds `folder` most closely, or the folder itself when none does. */
export function vscodeTarget(folder: string, stateFile = defaultStateFile()): EditorTarget | null {
  if (!isDirectory(folder)) return null;
  let best: { target: string; name: string; depth: number } | undefined;
  for (const window of openWindows(stateFile)) {
    for (const root of window.folders) {
      if (!contains(root, folder)) continue;
      const depth = resolve(root).length;
      if (!best || depth > best.depth) best = { target: window.target, name: window.name, depth };
    }
  }
  const target = best?.target ?? folder;
  return { link: fileLink(target), name: best?.name ?? basename(folder) };
}

interface OpenWindow {
  target: string;
  name: string;
  folders: string[];
}

function openWindows(stateFile: string): OpenWindow[] {
  const state = readJson(stateFile) as { windowsState?: { openedWindows?: unknown[]; lastActiveWindow?: unknown } } | undefined;
  const windows = [...(state?.windowsState?.openedWindows ?? []), state?.windowsState?.lastActiveWindow];
  return windows.flatMap((w): OpenWindow[] => {
    const entry = (w ?? {}) as { folder?: unknown; workspaceIdentifier?: { configURIPath?: unknown } };
    const workspace = filePath(entry.workspaceIdentifier?.configURIPath);
    if (workspace) {
      const folders = workspaceFolders(workspace);
      return folders.length ? [{ target: workspace, name: `${basename(workspace).replace(/\.code-workspace$/, '')} (Workspace)`, folders }] : [];
    }
    const folder = filePath(entry.folder);
    return folder ? [{ target: folder, name: basename(folder), folders: [folder] }] : [];
  });
}

function workspaceFolders(file: string): string[] {
  const workspace = readJson(file, true) as { folders?: Array<{ path?: unknown; uri?: unknown }> } | undefined;
  return (workspace?.folders ?? []).flatMap((f) => {
    if (typeof f.path === 'string') return [resolve(dirname(file), f.path)];
    const uri = filePath(f.uri);
    return uri ? [uri] : [];
  });
}

/** Opens a link with the operating system's handler, as a click would. */
export function openLink(url: string): void {
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

/** `vscode://file/C:/Users/me/My%20Repo`, keeping the drive letter's colon. */
export function fileLink(path: string): string {
  const parts = resolve(path).replace(/\\/g, '/').split('/');
  return `vscode://file/${parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join('/').replace(/^\//, '')}`;
}

function defaultStateFile(): string {
  const base = process.platform === 'win32' ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'Code', 'User', 'globalStorage', 'storage.json');
}

function contains(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function filePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file: string, comments = false): unknown {
  try {
    const text = readFileSync(file, 'utf8');
    return JSON.parse(comments ? withoutComments(text) : text);
  } catch {
    return undefined;
  }
}

// Workspace files are JSON with comments and trailing commas.
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}
