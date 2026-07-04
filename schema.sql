-- ProudOne D1 Database Schema
-- Run with: npx wrangler d1 execute proudone-db --local --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  invite_code TEXT,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspaces (
  user_id INTEGER PRIMARY KEY,
  profile TEXT DEFAULT '{}',
  roadmap TEXT DEFAULT 'null',
  tasks TEXT DEFAULT '[]',
  habits TEXT DEFAULT '{}',
  habit_names TEXT DEFAULT '[]',
  expenses TEXT DEFAULT '[]',
  workouts TEXT DEFAULT '[]',
  dsa TEXT DEFAULT '[]',
  sheet TEXT DEFAULT '[]',
  activity TEXT DEFAULT '{}',
  streaks TEXT DEFAULT '{"study":0,"gym":0,"budget":0}',
  wins TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  created_by INTEGER,
  used_by INTEGER,
  used_at TEXT,
  active INTEGER DEFAULT 1
);

-- Insert a default admin invite code (change this!)
INSERT OR IGNORE INTO invite_codes (code, created_by, active) VALUES ('PROUDONE-ALPHA', NULL, 1);
