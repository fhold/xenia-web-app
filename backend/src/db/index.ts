import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.DB_PATH ?? path.resolve(__dirname, "../../data/xenia.db");
const DATA_DIR = path.dirname(DB_PATH);

let db: DatabaseSync | null = null;

/**
 * Returns the singleton DB connection.
 * Throws if initDb() hasn't been called first.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return db;
}

/**
 * Opens (or creates) the SQLite database.
 * Must be called once at startup before anything else uses the DB.
 */
export function initDb(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);

  // WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
}

/**
 * Closes the SQLite connection. Safe to call when the DB was never opened
 * or already closed — used during graceful shutdown.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
