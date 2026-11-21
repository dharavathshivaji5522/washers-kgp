CREATE TABLE laundry_push (
  endpoint TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  subscription TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX laundry_push_owner ON laundry_push (owner);
