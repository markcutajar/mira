// Permission prompts Mira can answer (decisions 9 and 18). A prompt is held open only while Mira
// is open in a browser; otherwise the hub replies at once and the normal terminal prompt appears.
// What the tool wants to do is kept in memory to show the viewer, and never stored.

export interface PendingPrompt {
  id: string;
  sessionId: string;
  system: string;
  tool?: string;
  /** A short summary of the tool input: the command, the file, or a trimmed copy. */
  summary?: string;
  askedAt: string;
}

export type Decision = 'allow' | 'deny';

interface Held {
  prompt: PendingPrompt;
  resolve: (decision: Decision | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Permissions {
  #held = new Map<string, Held>();
  #waitMs: number;
  #watching: () => boolean;
  #onChange: () => void;

  constructor(options: { waitMs: number; watching: () => boolean; onChange?: () => void }) {
    this.#waitMs = options.waitMs;
    this.#watching = options.watching;
    this.#onChange = options.onChange ?? (() => {});
  }

  /** Resolves with Mira's decision, or null to let the terminal prompt take over. */
  ask(prompt: PendingPrompt): Promise<Decision | null> {
    if (!this.#watching()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#settle(prompt.id, null), this.#waitMs);
      this.#held.set(prompt.id, { prompt, resolve, timer });
      this.#onChange();
    });
  }

  answer(id: string, decision: Decision): boolean {
    return this.#settle(id, decision);
  }

  /** Drops a prompt whose session stopped waiting, for example because it was interrupted. */
  cancel(id: string): void {
    this.#settle(id, null);
  }

  pending(): PendingPrompt[] {
    return [...this.#held.values()].map((h) => h.prompt);
  }

  #settle(id: string, decision: Decision | null): boolean {
    const held = this.#held.get(id);
    if (!held) return false;
    clearTimeout(held.timer);
    this.#held.delete(id);
    held.resolve(decision);
    this.#onChange();
    return true;
  }
}

/** What the viewer needs to decide, without carrying whole files around. */
export function summarise(tool: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'url', 'pattern', 'path']) {
    if (typeof fields[key] === 'string') return trim(fields[key] as string);
  }
  return tool ? trim(JSON.stringify(input)) : undefined;
}

const trim = (s: string) => (s.length > 500 ? `${s.slice(0, 499)}…` : s);
