import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  source_id TEXT UNIQUE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  bank TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT
);
CREATE INDEX IF NOT EXISTS idx_movements_date ON movements(date);
CREATE TABLE IF NOT EXISTS merchant_rules (
  merchant TEXT PRIMARY KEY,
  category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budgets (
  category TEXT NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (category, month)
);
CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  merchant TEXT
);
CREATE TABLE IF NOT EXISTS senders (
  address TEXT PRIMARY KEY,
  label TEXT
);
CREATE TABLE IF NOT EXISTS parser_profiles (
  sender TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_log (
  message_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  subject TEXT
);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (currency, date)
);
`;

/** Columns added after the first release: databases created before them get them on open. */
const ADDED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: "movements", column: "detail", ddl: "TEXT" },
];

function addMissingColumns(db: DatabaseSync): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const have = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}
