-- Initial schema: key-value store for tower state
CREATE TABLE IF NOT EXISTS tower (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
