import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { fileLink, vscodeTarget } from '../src/editor.ts';

describe('vscodeTarget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-editor-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['projects/mira/mira/hub', 'projects/acme/acme-core', 'projects/acme/acme-pm', 'projects/loose', 'projects/elsewhere', 'settings']) {
    mkdirSync(join(dir, folder), { recursive: true });
  }
  // A workspace file the way VS Code writes them: comments, trailing commas, paths relative to the file.
  writeFileSync(join(dir, 'settings', 'mira.code-workspace'), '{\n  // my workspace\n  "folders": [\n    { "path": "../projects/mira/mira" }, /* the app */\n    { "path": "../projects/mira/pixel-agents" },\n  ],\n  "settings": { "x": "a // not a comment" },\n}');
  writeFileSync(join(dir, 'projects', 'acme', 'acme.code-workspace'), JSON.stringify({ folders: [{ path: 'acme-core' }, { path: 'acme-pm' }] }));
  const state = join(dir, 'storage.json');
  const url = (path: string) => pathToFileURL(path).href;
  writeFileSync(state, JSON.stringify({
    windowsState: {
      lastActiveWindow: { workspaceIdentifier: { id: 'k', configURIPath: url(join(dir, 'projects', 'acme', 'acme.code-workspace')) } },
      openedWindows: [
        { workspaceIdentifier: { id: 'm', configURIPath: url(join(dir, 'settings', 'mira.code-workspace')) } },
        { folder: url(join(dir, 'projects', 'loose')) },
      ],
    },
  }));

  it('finds the open workspace that holds the session folder', () => {
    assert.deepEqual(vscodeTarget(join(dir, 'projects', 'mira', 'mira', 'hub'), state), { link: fileLink(join(dir, 'settings', 'mira.code-workspace')), name: 'mira (Workspace)' });
    assert.equal(vscodeTarget(join(dir, 'projects', 'acme', 'acme-pm'), state)?.name, 'acme (Workspace)');
  });

  it('finds a window open on a plain folder', () => {
    assert.deepEqual(vscodeTarget(join(dir, 'projects', 'loose'), state), { link: fileLink(join(dir, 'projects', 'loose')), name: 'loose' });
  });

  it('falls back to the folder itself, and to nothing for a folder that is gone', () => {
    assert.deepEqual(vscodeTarget(join(dir, 'projects', 'elsewhere'), state), { link: fileLink(join(dir, 'projects', 'elsewhere')), name: 'elsewhere' });
    assert.equal(vscodeTarget(join(dir, 'projects', 'elsewhere'), join(dir, 'missing.json'))?.name, 'elsewhere');
    assert.equal(vscodeTarget(join(dir, 'nope'), state), null);
  });
});

describe('fileLink', () => {
  it('keeps the drive letter and encodes everything else', () => {
    if (process.platform === 'win32') assert.equal(fileLink('C:\\Users\\me\\My Repo #2'), 'vscode://file/C:/Users/me/My%20Repo%20%232');
    else assert.equal(fileLink('/home/me/My Repo #2'), 'vscode://file/home/me/My%20Repo%20%232');
  });
});
