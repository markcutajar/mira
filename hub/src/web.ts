// Serves the browser side: the page (the sky, with the board down its left, decision 31), the
// shared styles and modules, the sky's modules and Phaser. TypeScript goes out as JavaScript with
// its types stripped (decision 26), so there's no build step. Files are read on every request, so
// `npm run dev` picks up changes.

import { readFile, stat } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import type { ServerResponse } from 'node:http';

export const PAGE_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'";

const WEB = new URL('../web/', import.meta.url);
const SCRIPT = 'text/javascript; charset=utf-8';
const FIXED: Record<string, { file: URL; type: string }> = {
  '/': { file: new URL('index.html', WEB), type: 'text/html; charset=utf-8' },
  '/sky': { file: new URL('index.html', WEB), type: 'text/html; charset=utf-8' }, // the address the sky had before
  '/markdown.js': { file: new URL('markdown.js', WEB), type: SCRIPT },
  '/vendor/phaser.js': { file: new URL('../../node_modules/phaser/dist/phaser.min.js', import.meta.url), type: SCRIPT },
  '/vendor/xterm.js': { file: new URL('../../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url), type: SCRIPT },
  '/vendor/xterm-fit.js': { file: new URL('../../node_modules/@xterm/addon-fit/lib/addon-fit.js', import.meta.url), type: SCRIPT },
  '/vendor/xterm.css': { file: new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), type: 'text/css; charset=utf-8' },
};

export interface WebFile {
  file: URL;
  type: string;
  strip: boolean;
}

/** The file behind a path, or undefined. Only `/shared/` and `/sky/` hold modules and styles, and their names are plain words. */
export function webFile(pathname: string): WebFile | undefined {
  if (Object.hasOwn(FIXED, pathname)) return { ...(FIXED[pathname] as { file: URL; type: string }), strip: false };
  const m = pathname.match(/^\/((?:shared|sky)(?:\/[\w-]+)+)\.(ts|css)$/);
  if (!m) return undefined;
  return { file: new URL(`${m[1]}.${m[2]}`, WEB), type: m[2] === 'ts' ? SCRIPT : 'text/css; charset=utf-8', strip: m[2] === 'ts' };
}

const stripped = new Map<string, { mtimeMs: number; js: string }>();

export async function serveWeb(res: ServerResponse, target: WebFile): Promise<void> {
  try {
    let body: string | Buffer;
    if (target.strip) {
      const { mtimeMs } = await stat(target.file);
      let hit = stripped.get(target.file.href);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        hit = { mtimeMs, js: stripTypeScriptTypes(await readFile(target.file, 'utf8')) };
        stripped.set(target.file.href, hit);
      }
      body = hit.js;
    } else {
      body = await readFile(target.file);
    }
    res.writeHead(200, { 'Content-Type': target.type, 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_POLICY }).end(body);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(missing ? 'Not found.' : `Part of Mira's page failed: ${(err as Error).message}`);
  }
}
