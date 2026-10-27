import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';

export interface Place {
  system: string;
  /** Set when the folder is a git worktree: the worktree's own folder name. */
  worktree?: string;
  /** Set when the section is a group of repos (decision 47): this repo's own folder name. */
  repo?: string;
  /** The project's own folder: the repo root, the main repo for a worktree, or the folder itself outside a repo. */
  root?: string;
}

// The config names sections by folder (decision 16), exactly or by a pattern where `*` stands for
// anything, matched without case (decision 47): `"acme-*": "Acme"` groups every acme repo.
// An exact name wins over a pattern, and patterns are tried in the order they're written.
export function makeSectionNamer(renames: Record<string, string>) {
  const exact = new Map<string, string>();
  const patterns: Array<[RegExp, string]> = [];
  const folders = new Map<string, number>(); // how many folders each name can take in
  for (const [key, name] of Object.entries(renames)) {
    if (key.includes('*')) patterns.push([new RegExp(`^${key.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'), name]);
    else exact.set(key, name);
    folders.set(name, (folders.get(name) ?? 0) + (key.includes('*') ? 2 : 1));
  }
  return {
    /** The section a folder belongs to, which is also what a section stored before a change belongs to now. */
    name: (folder: string) => (exact.get(folder) ?? patterns.find(([pattern]) => pattern.test(folder))?.[1] ?? folder).slice(0, 80),
    /** Whether a section takes in several repos: a pattern names it, or more than one folder does. */
    isGroup: (section: string) => (folders.get(section) ?? 0) > 1,
  };
}

/** What a folder's `.git` entry says: a repo of its own, a link to a git dir elsewhere, or nothing. */
export type GitMarker = { kind: 'repo' } | { kind: 'link'; gitdir: string } | null;

function readGitMarker(dir: string): GitMarker {
  try {
    const marker = resolvePath(dir, '.git');
    if (statSync(marker).isDirectory()) return { kind: 'repo' };
    const gitdir = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    return gitdir ? { kind: 'link', gitdir } : { kind: 'repo' };
  } catch {
    return null;
  }
}

// A session's section is its repo's folder name (decision 16), unless the config renames or groups it.
// A git worktree joins its main repo's section and keeps its own folder name as a label. Submodules
// link into `.git/modules/` instead, and stay sections of their own. Outside a repo, the working
// folder's own name is used. In a group, each session is labelled with its own repo.
export function makePlaceResolver(renames: Record<string, string>, gitMarker = readGitMarker) {
  const cache = new Map<string, Place>();
  const sections = makeSectionNamer(renames);
  const named = (folder: string, extra: Omit<Place, 'system' | 'repo'>): Place => {
    const system = sections.name(folder);
    return { system, ...extra, ...(sections.isGroup(system) ? { repo: folder.slice(0, 80) } : {}) };
  };
  // VS Code reports some folders as `c:\…` and others as `C:\…`; one spelling keeps a repo from counting twice.
  const resolve = (...paths: string[]) => resolvePath(...paths).replace(/^[a-z]:/, (drive) => drive.toUpperCase());

  function placeOf(root: string, marker: Exclude<GitMarker, null>): Place {
    const folder = basename(root) || root;
    if (marker.kind === 'link') {
      const gitdir = isAbsolute(marker.gitdir) ? marker.gitdir : resolve(root, marker.gitdir);
      const main = gitdir.replace(/\\/g, '/').match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/)?.[1];
      if (main) return named(basename(main), { worktree: folder.slice(0, 80), root: resolve(main) });
    }
    return named(folder, { root });
  }

  return function placeFor(cwd: string | undefined): Place {
    if (!cwd) return { system: 'unknown' };
    const known = cache.get(cwd);
    if (known) return known;
    let place = named(basename(resolve(cwd)) || cwd, { root: resolve(cwd) });
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const marker = gitMarker(dir);
      if (marker) {
        place = placeOf(dir, marker);
        break;
      }
      if (dirname(dir) === dir) break;
    }
    cache.set(cwd, place);
    return place;
  };
}
