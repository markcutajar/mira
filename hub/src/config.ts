import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { Price } from './pricing.ts';

export const miraHome = process.env.MIRA_HOME ?? join(homedir(), '.mira');
export const claudeProjects = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

/** The pop-up's quick replies (decision 57), unless the config names its own. */
export const QUICK_REPLIES = ['Go ahead', 'Commit', 'Commit and push'];

const Config = z.object({
  port: z.number().int().min(1).max(65535).default(4711),
  /** Rename or group sections: repo folder name to section name. */
  systems: z.record(z.string(), z.string().min(1).max(80)).default({}),
  /** Which names mirlings get (decision 48). */
  mirlingNames: z.enum(['cute', 'stars']).default('cute'),
  /** Keep logging payload shapes to ~/.mira/recordings, as the step 0 recorder did. */
  recordShapes: z.boolean().default(true),
  /** How long a permission prompt waits for Mira while Mira is open. Keep it under the hook's timeout. */
  permissionWaitSeconds: z.number().int().min(1).max(600).default(60),
  /** On startup, sessions whose transcripts changed this recently count as still running. */
  activeHours: z.number().min(0).max(72).default(2),
  /** Days of events to keep; per-turn token counts are kept regardless (decision 32). 0 keeps everything. */
  keepDays: z.number().int().min(0).default(90),
  /** How long a quiet session stays in view: one still working, and any other (decision 33). */
  quiet: z.object({ workingMinutes: z.number().min(1).default(60), idleHours: z.number().min(1).default(12) }).default({ workingMinutes: 60, idleHours: 12 }),
  /** The quick replies on the app's pop-up (decision 57), one click each. */
  quickReplies: z.array(z.string().trim().min(1).max(200)).max(6).default(QUICK_REPLIES),
  /** Check every few hours whether the repo Mira was cloned from has new commits (decision 60). */
  checkForUpdates: z.boolean().default(true),
  /** Override or add model prices, in US dollars per million tokens, for cost estimates. */
  prices: z.record(z.string(), Price).default({}),
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
