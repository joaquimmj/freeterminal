-- Global daily request counter (see src/guard.ts). One row per UTC day.
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
