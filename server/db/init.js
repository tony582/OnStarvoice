import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;
let dbPath = '';

export async function initDb() {
  if (db) return db;

  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, 'onstarvoice.db');

  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  // 建表
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.run(schema);

  // 持久化
  saveDb();

  console.log('[DB] SQLite initialized:', dbPath);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function saveDb() {
  if (!db) return;
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

// 每 30 秒自动保存
let saveInterval = null;
export function startAutoSave() {
  if (saveInterval) return;
  saveInterval = setInterval(() => saveDb(), 30000);
}

export function closeDb() {
  if (saveInterval) { clearInterval(saveInterval); saveInterval = null; }
  if (db) { saveDb(); db.close(); db = null; console.log('[DB] Connection closed'); }
}

// ==================== 通用查询辅助（适配 sql.js API）====================

export function getSetting(key) {
  const stmt = getDb().prepare('SELECT value FROM settings WHERE key = ?');
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row.value ?? '';
  }
  stmt.free();
  return '';
}

export function setSetting(key, value) {
  getDb().run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value)]
  );
  saveDb();
}

export function getSettings(...keys) {
  const result = {};
  for (const key of keys) {
    result[key] = getSetting(key);
  }
  return result;
}

export function setSettings(obj) {
  const db = getDb();
  for (const [key, value] of Object.entries(obj)) {
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value ?? '')]
    );
  }
  saveDb();
}

export function getAllSettings() {
  const stmt = getDb().prepare('SELECT key, value FROM settings');
  const result = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    result[row.key] = row.value;
  }
  stmt.free();
  return result;
}

// ==================== sql.js 查询辅助 ====================

/**
 * 执行 SELECT 查询，返回行数组
 */
export function queryAll(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * 执行 SELECT 查询，返回第一行
 */
export function queryOne(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

/**
 * 执行 INSERT/UPDATE/DELETE，返回 { changes, lastInsertRowid }
 */
export function execute(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
  const changes = db.getRowsModified();
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  saveDb();
  return { changes, lastInsertRowid: lastId?.id ?? 0 };
}
