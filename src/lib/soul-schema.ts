// Common distribution Soul schema, derived from the MIT-licensed Mimir Rust core.
export const SOUL_SCHEMA_SQL = `
-- experiences: the atomic unit of learning
CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('success','failure','correction','pattern')),
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('critical','error','warning','info')),
  context TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  correction TEXT,
  source_ref TEXT,
  frequency INTEGER NOT NULL DEFAULT 1,
  token_cost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 full-text search index on experiences
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  context, action, outcome, correction,
  content=experiences,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS experiences_ai AFTER INSERT ON experiences BEGIN
  INSERT INTO experiences_fts(rowid, context, action, outcome, correction)
  VALUES (new.rowid, new.context, new.action, new.outcome, new.correction);
END;

CREATE TRIGGER IF NOT EXISTS experiences_ad AFTER DELETE ON experiences BEGIN
  INSERT INTO experiences_fts(experiences_fts, rowid, context, action, outcome, correction)
  VALUES ('delete', old.rowid, old.context, old.action, old.outcome, old.correction);
END;

CREATE TRIGGER IF NOT EXISTS experiences_au AFTER UPDATE ON experiences BEGIN
  INSERT INTO experiences_fts(experiences_fts, rowid, context, action, outcome, correction)
  VALUES ('delete', old.rowid, old.context, old.action, old.outcome, old.correction);
  INSERT INTO experiences_fts(rowid, context, action, outcome, correction)
  VALUES (new.rowid, new.context, new.action, new.outcome, new.correction);
END;

-- insights: learned patterns extracted from experience
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  agent TEXT NOT NULL,
  description TEXT NOT NULL,
  compressed TEXT NOT NULL DEFAULT '',
  token_cost INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project','agent')),
  importance INTEGER NOT NULL DEFAULT 2,
  confidence REAL NOT NULL DEFAULT 0.5,
  effect_score REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dormant','retired','graduated')),
  converted_type TEXT,
  converted_ref TEXT
);

-- tags: hierarchical tag chain for cascading recall
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL,
  UNIQUE(experience_id, level, tag)
);

-- embeddings: optional vector storage for semantic search
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('experience','insight')),
  source_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'nomic-embed-text',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, model)
);

-- effect_tracking: measure if injected insights actually helped
CREATE TABLE IF NOT EXISTS effect_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  was_relevant INTEGER NOT NULL DEFAULT 0,
  was_followed INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'neutral' CHECK(outcome IN ('positive','neutral','negative')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- experience↔insight links (N:M relationship)
CREATE TABLE IF NOT EXISTS experience_insight_links (
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'supports' CHECK(relation IN ('supports','contradicts')),
  PRIMARY KEY (experience_id, insight_id)
);

-- insight↔insight links (graph)
CREATE TABLE IF NOT EXISTS insight_links (
  source_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related' CHECK(relation IN ('related','extends','supersedes')),
  PRIMARY KEY (source_id, target_id)
);

-- schema version tracking
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- tag_similarity: user-confirmed tag equivalences (architecture.md 8-8)
-- confidence starts at 0.5, rises with re-confirmation, auto-match at >= 0.9
CREATE TABLE IF NOT EXISTS tag_similarity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_a TEXT NOT NULL,
  tag_b TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tag_a, tag_b)
);

-- Performance indexes (architecture.md section 8-2)
CREATE INDEX IF NOT EXISTS idx_exp_project_category ON experiences(project, category);
CREATE INDEX IF NOT EXISTS idx_exp_type_severity ON experiences(type, severity);
CREATE INDEX IF NOT EXISTS idx_exp_timestamp ON experiences(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exp_project_agent ON experiences(project, agent);
CREATE INDEX IF NOT EXISTS idx_tags_level_tag ON tags(level, tag);
CREATE INDEX IF NOT EXISTS idx_tags_exp ON tags(experience_id);
CREATE INDEX IF NOT EXISTS idx_ins_status ON insights(status, importance DESC);
CREATE INDEX IF NOT EXISTS idx_ins_category ON insights(category);
CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_eff_insight ON effect_tracking(insight_id);
CREATE INDEX IF NOT EXISTS idx_exp_ins_link ON experience_insight_links(insight_id);
CREATE INDEX IF NOT EXISTS idx_tag_sim_a ON tag_similarity(tag_a);
CREATE INDEX IF NOT EXISTS idx_tag_sim_b ON tag_similarity(tag_b);
`;
