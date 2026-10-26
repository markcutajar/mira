import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export interface Place {
  system: string;
  /** Set when the folder is a git worktree: the worktree's own folder name. */
  worktree?: string;
}

/** What a folder's `.git` entry says: a repo of its own, a link to a git dir elsewhere, or nothing. */
export type GitMarker = { kind: 'repo' } | { kind: 'link'; gitdir: string } | null;

function readGitMarker(dir: string): GitMarker {
  try {
    const marker = resolve(dir, '.git');
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
// folder's own name is used.
export function makePlaceResolver(renames: Record<string, string>, gitMarker = readGitMarker) {
  const cache = new Map<string, Place>();
  const named = (folder: string) => (renames[folder] ?? folder).slice(0, 80);

  function placeOf(root: string, marker: Exclude<GitMarker, null>): Place {
    const folder = basename(root) || root;
    if (marker.kind === 'link') {
      const gitdir = isAbsolute(marker.gitdir) ? marker.gitdir : resolve(root, marker.gitdir);
      const main = gitdir.replace(/\\/g, '/').match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/)?.[1];
      if (main) return { system: named(basename(main)), worktree: folder.slice(0, 80) };
    }
    return { system: named(folder) };
  }

  return function placeFor(cwd: string | undefined): Place {
    if (!cwd) return { system: 'unknown' };
    const known = cache.get(cwd);
    if (known) return known;
    let place: Place = { system: named(basename(resolve(cwd)) || cwd) };
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
