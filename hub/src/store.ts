// All hub storage goes through here (decision 17), so moving off SQLite later stays in one file.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MiraEvent } from '../../contracts/src/index.ts';
import type { SectionLayout } from './layout.ts';

/** What I can rename or remove from view: a project (system) or a session. */
export type Kind = 'system' | 'session';

export class Store {
  #db: DatabaseSync;
  #insert: StatementSync;
  #recent: StatementSync;
  #since: StatementSync;
  #sinceOfType: StatementSync;
  #systems: StatementSync;
  #folders: StatementSync;
  #names: StatementSync;
  #setName: StatementSync;
  #clearName: StatementSync;
  #removed: StatementSync;
  #remove: StatementSync;
  #prune: StatementSync;
  #layouts: StatementSync;
  #setLayout: StatementSync;
  #clearLayout: StatementSync;
  #spent: StatementSync;
  #stored: StatementSync;
  #systemOf: (stored: string) => string;

  // Events keep the section they were stored under. `systemOf` maps that to the section it belongs
  // to now, so a repo grouped in the config brings its history into the group (decision 47).
  constructor(file: string, systemOf: (stored: string) => string = (stored) => stored) {
    this.#systemOf = systemOf;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        system TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_at ON events (at);
      CREATE INDEX IF NOT EXISTS events_actor ON events (actor_id, at);
      -- My own names for projects and sessions, and what I removed from view and when (decision 30).
      CREATE TABLE IF NOT EXISTS names (kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS removed (kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (kind, key));
      -- How I arranged each project's section of the island in build mode (decision 39).
      CREATE TABLE IF NOT EXISTS layouts (system TEXT PRIMARY KEY, layout TEXT NOT NULL);
    `);
    this.#insert = this.#db.prepare('INSERT OR IGNORE INTO events (id, at, source, system, actor_id, type, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.#recent = this.#db.prepare('SELECT body FROM events ORDER BY seq DESC LIMIT ?');
    this.#since = this.#db.prepare('SELECT body FROM events WHERE at >= ? ORDER BY at, seq');
    this.#sinceOfType = this.#db.prepare('SELECT body FROM events WHERE at >= ? AND type = ? ORDER BY at, seq');
    // A folder move never makes a project of its own (decision 27).
    this.#systems = this.#db.prepare("SELECT system, MIN(at) AS first_at, MAX(at) AS last_at FROM events WHERE type != 'session.moved' GROUP BY system");
    this.#stored = this.#db.prepare('SELECT DISTINCT system FROM events');
    this.#names = this.#db.prepare('SELECT key, name FROM names WHERE kind = ?');
    this.#setName = this.#db.prepare('INSERT INTO names (kind, key, name) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET name = excluded.name');
    this.#clearName = this.#db.prepare('DELETE FROM names WHERE kind = ? AND key = ?');
    this.#removed = this.#db.prepare('SELECT key, at FROM removed WHERE kind = ?');
    this.#remove = this.#db.prepare('INSERT INTO removed (kind, key, at) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET at = excluded.at');
    this.#layouts = this.#db.prepare('SELECT system, layout FROM layouts');
    this.#setLayout = this.#db.prepare('INSERT INTO layouts (system, layout) VALUES (?, ?) ON CONFLICT (system) DO UPDATE SET layout = excluded.layout');
    this.#clearLayout = this.#db.prepare('DELETE FROM layouts WHERE system = ?');
    // A subagent's tokens count towards the session that started it, as on the board.
    this.#spent = this.#db.prepare(`SELECT COALESCE(json_extract(body, '$.actor.parent'), actor_id) AS session,
      SUM(COALESCE(json_extract(body, '$.usage.inputTokens'), 0) + COALESCE(json_extract(body, '$.usage.outputTokens'), 0)
        + COALESCE(json_extract(body, '$.usage.cacheReadTokens'), 0) + COALESCE(json_extract(body, '$.usage.cacheWriteTokens'), 0)) AS tokens,
      SUM(COALESCE(json_extract(body, '$.usage.costUsd'), 0)) AS cost
      FROM events WHERE type = 'usage.reported' AND system IN (SELECT value FROM json_each(?)) GROUP BY session`);
    this.#prune = this.#db.prepare("DELETE FROM events WHERE at < ? AND type != 'usage.reported'");
    this.#folders = this.#db.prepare("SELECT json_extract(body, '$.detail.cwd') AS cwd FROM events WHERE system IN (SELECT value FROM json_each(?)) AND type != 'session.moved' AND cwd IS NOT NULL GROUP BY cwd ORDER BY MAX(at) DESC LIMIT ?");
  }

  /** The names a system's events were stored under, as a JSON list for the queries above. */
  #storedAs(system: string): string {
    return JSON.stringify(this.#stored.all().map((row) => String(row.system)).filter((stored) => this.#systemOf(stored) === system));
  }

  #read(body: unknown): MiraEvent {
    const event = JSON.parse(String(body)) as MiraEvent;
    event.system = this.#systemOf(event.system);
    return event;
  }

  /** Stores an event; returns false if one with the same id is already stored. */
  add(event: MiraEvent): boolean {
    const result = this.#insert.run(event.id, event.at, event.source, event.system, event.actor.id, event.type, event.status ?? null, JSON.stringify(event));
    return result.changes > 0;
  }

  /** The newest events first. */
  recent(limit: number): MiraEvent[] {
    return this.#recent.all(limit).map((row) => this.#read(row.body));
  }

  /** Events at or after `at`, oldest first, optionally of one type. */
  since(at: string, type?: MiraEvent['type']): MiraEvent[] {
    const rows = type ? this.#sinceOfType.all(at, type) : this.#since.all(at);
    return rows.map((row) => this.#read(row.body));
  }

  /** Every system with events since `at`, in the order each first appeared, so the island grows at its edge. */
  systems(at: string): Array<{ name: string; firstAt: string; lastAt: string }> {
    const by = new Map<string, { name: string; firstAt: string; lastAt: string }>();
    for (const row of this.#systems.all()) {
      const name = this.#systemOf(String(row.system));
      const [firstAt, lastAt] = [String(row.first_at), String(row.last_at)];
      const known = by.get(name);
      by.set(name, known ? { name, firstAt: firstAt < known.firstAt ? firstAt : known.firstAt, lastAt: lastAt > known.lastAt ? lastAt : known.lastAt } : { name, firstAt, lastAt });
    }
    return [...by.values()].filter((s) => s.lastAt >= at).sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.name.localeCompare(b.name));
  }

  /** The working folders a system's events have named, most recently used first. */
  folders(system: string, limit = 20): string[] {
    return this.#folders.all(this.#storedAs(system), limit).map((row) => String(row.cwd));
  }

  /** The tokens and estimated cost of every session in a project that reported any, by session. */
  spent(system: string): Record<string, { tokens: number; costUsd: number }> {
    return Object.fromEntries(this.#spent.all(this.#storedAs(system)).map((row) => [String(row.session), { tokens: Number(row.tokens), costUsd: Math.round(Number(row.cost) * 1e6) / 1e6 }]));
  }

  /** My names for projects or sessions, by key. */
  names(kind: Kind): Record<string, string> {
    return Object.fromEntries(this.#names.all(kind).map((row) => [String(row.key), String(row.name)]));
  }

  /** Names a project or session; an empty name goes back to its own. */
  setName(kind: Kind, key: string, name: string): void {
    if (name) this.#setName.run(kind, key, name);
    else this.#clearName.run(kind, key);
  }

  /** How I arranged each project's section, by project. A group I haven't arranged yet starts from the repo I arranged most. */
  layouts(): Record<string, SectionLayout> {
    const chosen = new Map<string, { layout: string; own: boolean }>();
    for (const row of this.#layouts.all()) {
      const [key, layout] = [String(row.system), String(row.layout)];
      const section = this.#systemOf(key);
      const own = section === key;
      const best = chosen.get(section);
      if (!best || (own && !best.own) || (!best.own && !own && layout.length > best.layout.length)) chosen.set(section, { layout, own });
    }
    return Object.fromEntries([...chosen].map(([section, { layout }]) => [section, JSON.parse(layout) as SectionLayout]));
  }

  /** Keeps a project's layout; null forgets it. */
  setLayout(system: string, layout: SectionLayout | null): void {
    if (layout) this.#setLayout.run(system, JSON.stringify(layout));
    else this.#clearLayout.run(system);
  }

  /** When each project or session was removed from view, by key. */
  removed(kind: Kind): Record<string, string> {
    return Object.fromEntries(this.#removed.all(kind).map((row) => [String(row.key), String(row.at)]));
  }

  /** Removes a project or session from view as of `at`; anything that happens after brings it back. */
  remove(kind: Kind, key: string, at: string): void {
    this.#remove.run(kind, key, at);
  }

  /** Deletes events from before `at`, keeping per-turn token counts, which are the cost history (decision 32). */
  prune(at: string): number {
    return Number(this.#prune.run(at).changes);
  }

  close(): void {
    this.#db.close();
  }
}
