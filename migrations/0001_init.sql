CREATE TABLE projects (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  repos TEXT NOT NULL DEFAULT '', -- git repo names, comma-joined, lowercase. One project per repo
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(key),
  num INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'todo', 'doing', 'done', 'cancelled')),
  assignee TEXT,
  branch TEXT NOT NULL,
  parent TEXT REFERENCES tickets(id),
  pr TEXT,
  body TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '', -- comma-joined, lowercase, e.g. 'bug,repo:cradle'
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, num)
);
CREATE INDEX tickets_status ON tickets(status);
CREATE INDEX tickets_parent ON tickets(parent);

CREATE TABLE deps (
  ticket TEXT NOT NULL REFERENCES tickets(id),
  blocked_by TEXT NOT NULL REFERENCES tickets(id),
  PRIMARY KEY (ticket, blocked_by)
) WITHOUT ROWID;

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  ticket TEXT NOT NULL REFERENCES tickets(id),
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  text TEXT NOT NULL
);
CREATE INDEX notes_ticket ON notes(ticket);
