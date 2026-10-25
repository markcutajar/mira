import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

export const miraHome = process.env.MIRA_HOME ?? join(homedir(), '.mira');
export const claudeProjects = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

const Config = z.object({
  port: z.number().int().min(1).max(65535).default(4711),
  /** Rename or group sections: repo folder name to section name. */
  systems: z.record(z.string(), z.string().min(1).max(80)).default({}),
  /** Keep logging payload shapes to ~/.mira/recordings, as the step 0 recorder did. */
  recordShapes: z.boolean().default(true),
  /** How long a permission prompt waits for Mira while Mira is open. Keep it under the hook's timeout. */
  permissionWaitSeconds: z.number().int().min(1).max(600).default(60),
  /** On startup, sessions whose transcripts changed this recently count as still running. */
  activeHours: z.number().min(0).max(72).default(2),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(file = join(miraHome, 'config.json')): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Can't read ${file}: ${(err as Error).message}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} isn't valid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
