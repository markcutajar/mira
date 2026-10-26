// All hub storage goes through here (decision 17), so moving off SQLite later stays in one file.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MiraEvent } from '../../contracts/src/index.ts';

export class Store {
  #db: DatabaseSync;
  #insert: StatementSync;
  #recent: StatementSync;
  #since: StatementSync;
  #sinceOfType: StatementSync;
  #systems: StatementSync;

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
    `);
    this.#insert = this.#db.prepare('INSERT OR IGNORE INTO events (id, at, source, system, actor_id, type, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.#recent = this.#db.prepare('SELECT body FROM events ORDER BY seq DESC LIMIT ?');
    this.#since = this.#db.prepare('SELECT body FROM events WHERE at >= ? ORDER BY at, seq');
    this.#sinceOfType = this.#db.prepare('SELECT body FROM events WHERE at >= ? AND type = ? ORDER BY at, seq');
    // A folder move never makes a project of its own (decision 27).
    this.#systems = this.#db.prepare("SELECT system, MIN(at) AS first_at, MAX(at) AS last_at FROM events WHERE type != 'session.moved' GROUP BY system HAVING MAX(at) >= ? ORDER BY first_at, system");
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

  close(): void {
    this.#db.close();
  }
}
