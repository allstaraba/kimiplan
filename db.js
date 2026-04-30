'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'allstar.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin', 'BCBA', 'Student')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS plan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    client_name TEXT DEFAULT '',
    original_notes TEXT NOT NULL,
    status TEXT DEFAULT 'Draft',
    notes TEXT DEFAULT '',
    plan_type TEXT DEFAULT 'initial',
    clinical_review_complete INTEGER DEFAULT 0,
    clinical_reviewed_by INTEGER,
    clinical_reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clinical_reviewed_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS plan_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    revision_number INTEGER NOT NULL,
    text TEXT NOT NULL,
    feedback TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    username TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id)
  );

  CREATE TABLE IF NOT EXISTS authorization_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    period_number INTEGER NOT NULL,
    period_type TEXT NOT NULL CHECK(period_type IN ('initial', 'reauth')),
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'pending')),
    plan_revision_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id),
    FOREIGN KEY (plan_revision_id) REFERENCES plan_revisions(id)
  );

  CREATE TABLE IF NOT EXISTS client_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER UNIQUE NOT NULL,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id)
  );

  CREATE TABLE IF NOT EXISTS client_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    uploaded_by INTEGER NOT NULL,
    authorization_period_id INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id),
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS insurance_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS insurance_template_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    saved_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES insurance_templates(id),
    FOREIGN KEY (saved_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS compliance_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER,
    document_name TEXT,
    template_id INTEGER,
    template_name TEXT NOT NULL,
    result_text TEXT NOT NULL,
    checked_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (checked_by) REFERENCES users(id)
  );

  -- Goal Bank: curated, clinically sound goals written by BCBAs
  CREATE TABLE IF NOT EXISTS goal_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL CHECK(domain IN ('Communication','Social','Adaptive','Behavior Reduction','Caregiver Training')),
    goal_text TEXT NOT NULL,
    baseline_template TEXT DEFAULT '',
    is_ferb INTEGER DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Plan Goals: goals attached to a specific plan
  CREATE TABLE IF NOT EXISTS plan_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    goal_bank_id INTEGER,
    domain TEXT NOT NULL,
    goal_number INTEGER NOT NULL,
    goal_statement TEXT NOT NULL,
    baseline TEXT DEFAULT '',
    is_ferb INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plan_history(id),
    FOREIGN KEY (goal_bank_id) REFERENCES goal_bank(id)
  );
`);

// Migration: add clinical review columns if missing (for existing DBs)
try { db.exec("ALTER TABLE plan_history ADD COLUMN clinical_review_complete INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE plan_history ADD COLUMN clinical_reviewed_by INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE plan_history ADD COLUMN clinical_reviewed_at DATETIME"); } catch(e) {}

// Seed system prompt (first run only)
const promptExists = db.prepare('SELECT id FROM prompt_versions WHERE id = 1').get();
if (!promptExists) {
  let systemPromptText = 'System prompt will be loaded here';
  const systemPromptPath = path.join(__dirname, 'system-prompt.txt');
  if (fs.existsSync(systemPromptPath)) {
    systemPromptText = fs.readFileSync(systemPromptPath, 'utf8');
  }
  db.prepare('INSERT INTO prompt_versions (text, label, is_active) VALUES (?, ?, 1)')
    .run(systemPromptText, 'Initial System Prompt');
}

// Migration: update active prompt with latest system-prompt.txt if the file is newer than the DB entry
const SYSTEM_PROMPT_VERSION = 'v14-allstar-master-template-2026-04-30';
const migrationDone = db.prepare("SELECT id FROM prompt_versions WHERE label = ?").get(SYSTEM_PROMPT_VERSION);
if (!migrationDone) {
  const systemPromptPath = path.join(__dirname, 'system-prompt.txt');
  if (fs.existsSync(systemPromptPath)) {
    const newText = fs.readFileSync(systemPromptPath, 'utf8');
    db.prepare('UPDATE prompt_versions SET is_active = 0').run();
    db.prepare('INSERT INTO prompt_versions (text, label, is_active) VALUES (?, ?, 1)')
      .run(newText, SYSTEM_PROMPT_VERSION);
  }
}

// Migration: add document_name column if it doesn't exist (for existing DBs)
try {
  db.exec(`ALTER TABLE compliance_checks ADD COLUMN document_name TEXT`);
} catch {}

// Migration: drop plan_id NOT NULL constraint — SQLite doesn't support ALTER COLUMN
try {
  const cols = db.prepare(`PRAGMA table_info(compliance_checks)`).all();
  const planIdCol = cols.find(c => c.name === 'plan_id');
  if (planIdCol && planIdCol.notnull === 1) {
    db.exec(`
      BEGIN;
      ALTER TABLE compliance_checks RENAME TO compliance_checks_old;
      CREATE TABLE compliance_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER,
        document_name TEXT,
        template_id INTEGER,
        template_name TEXT NOT NULL,
        result_text TEXT NOT NULL,
        checked_by INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (checked_by) REFERENCES users(id)
      );
      INSERT INTO compliance_checks (id, plan_id, template_id, template_name, result_text, checked_by, created_at)
        SELECT id, plan_id, template_id, template_name, result_text, checked_by, created_at FROM compliance_checks_old;
      DROP TABLE compliance_checks_old;
      COMMIT;
    `);
  }
} catch {}

module.exports = db;
