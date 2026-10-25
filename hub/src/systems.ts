import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const hasGit = (dir: string) => existsSync(resolve(dir, '.git'));

// A session's section is its repo's folder name (decision 16), unless the config renames or groups it.
// Outside a repo, the working folder's own name is used.
export function makeSystemResolver(renames: Record<string, string>, isRepoRoot = hasGit) {
  const cache = new Map<string, string>();
  return function systemFor(cwd: string | undefined): string {
    if (!cwd) return 'unknown';
    const known = cache.get(cwd);
    if (known) return known;
    let root = resolve(cwd);
    for (let dir = root; ; dir = dirname(dir)) {
      if (isRepoRoot(dir)) { root = dir; break; }
      if (dirname(dir) === dir) break;
    }
    const folder = basename(root) || root;
    const name = (renames[folder] ?? folder).slice(0, 80);
    cache.set(cwd, name);
    return name;
  };
}
