// What each of Claude Code's tools sends a mirling to do (decision 41): read at the library, make at
// the workshop, run a command there, or think on its feet. The island acts it out, and the hub counts
// it for the paths mirlings wear (decision 67). It lives with the page's shared modules, and the hub
// imports it from here.

export type ToolAct = 'read' | 'make' | 'run' | 'think';

export const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead']);
const MAKING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DIRECTING = new Set(['Task', 'Agent']);

export const actFor = (tool: string | null): ToolAct => (!tool || DIRECTING.has(tool) ? 'think' : READING.has(tool) ? 'read' : MAKING.has(tool) ? 'make' : 'run');

/** A project's trips in the last 30 days (decision 67): to the library, to the workshop, and from a finished turn to play. */
export interface Trips {
  read: number;
  make: number;
  run: number;
  turns: number;
}
