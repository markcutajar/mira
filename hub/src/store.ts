// All hub storage goes through here (decision 17), so moving off SQLite later stays in one file.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MiraEvent } from '../../contracts/src/index.ts';

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

  constructor(file: string) {
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
    `);
    this.#insert = this.#db.prepare('INSERT OR IGNORE INTO events (id, at, source, system, actor_id, type, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.#recent = this.#db.prepare('SELECT body FROM events ORDER BY seq DESC LIMIT ?');
    this.#since = this.#db.prepare('SELECT body FROM events WHERE at >= ? ORDER BY at, seq');
    this.#sinceOfType = this.#db.prepare('SELECT body FROM events WHERE at >= ? AND type = ? ORDER BY at, seq');
    // A folder move never makes a project of its own (decision 27).
    this.#systems = this.#db.prepare("SELECT system, MIN(at) AS first_at, MAX(at) AS last_at FROM events WHERE type != 'session.moved' GROUP BY system HAVING MAX(at) >= ? ORDER BY first_at, system");
    this.#names = this.#db.prepare('SELECT key, name FROM names WHERE kind = ?');
    this.#setName = this.#db.prepare('INSERT INTO names (kind, key, name) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET name = excluded.name');
    this.#clearName = this.#db.prepare('DELETE FROM names WHERE kind = ? AND key = ?');
    this.#removed = this.#db.prepare('SELECT key, at FROM removed WHERE kind = ?');
    this.#remove = this.#db.prepare('INSERT INTO removed (kind, key, at) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET at = excluded.at');
    this.#prune = this.#db.prepare("DELETE FROM events WHERE at < ? AND type != 'usage.reported'");
    this.#folders = this.#db.prepare("SELECT json_extract(body, '$.detail.cwd') AS cwd FROM events WHERE system = ? AND type != 'session.moved' AND cwd IS NOT NULL GROUP BY cwd ORDER BY MAX(at) DESC LIMIT ?");
  }

  /** Stores an event; returns false if one with the same id is already stored. */
  add(event: MiraEvent): boolean {
    const result = this.#insert.run(event.id, event.at, event.source, event.system, event.actor.id, event.type, event.status ?? null, JSON.stringify(event));
    return result.changes > 0;
  }

  /** The newest events first. */
  recent(limit: number): MiraEvent[] {
    return this.#recent.all(limit).map((row) => JSON.parse(String(row.body)) as MiraEvent);
  }

  /** Events at or after `at`, oldest first, optionally of one type. */
  since(at: string, type?: MiraEvent['type']): MiraEvent[] {
    const rows = type ? this.#sinceOfType.all(at, type) : this.#since.all(at);
    return rows.map((row) => JSON.parse(String(row.body)) as MiraEvent);
  }

  /** Every system with events since `at`, in the order each first appeared, so the island grows at its edge. */
  systems(at: string): Array<{ name: string; firstAt: string; lastAt: string }> {
    return this.#systems.all(at).map((row) => ({ name: String(row.system), firstAt: String(row.first_at), lastAt: String(row.last_at) }));
  }

  /** The working folders a system's events have named, most recently used first. */
  folders(system: string, limit = 20): string[] {
    return this.#folders.all(system, limit).map((row) => String(row.cwd));
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
