import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";

export class GatewayDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    }

    this.connection = new DatabaseSync(path, {
      defensive: true,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);

    const appliedRows = this.connection
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const insert = this.connection.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.connection.exec(migration.sql);
        insert.run(migration.version, migration.name, Date.now());
      });
    }
  }
}
