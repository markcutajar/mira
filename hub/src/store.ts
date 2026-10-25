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

  /** Events at or after `at`, oldest first. */
  since(at: string): MiraEvent[] {
    return this.#since.all(at).map((row) => JSON.parse(String(row.body)) as MiraEvent);
  }

  close(): void {
    this.#db.close();
  }
}
