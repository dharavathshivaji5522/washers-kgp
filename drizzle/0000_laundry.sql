CREATE TABLE laundry_boards (
  board_key TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL
);
