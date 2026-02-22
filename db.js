const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'bot.db');

function getDb() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = getDb();

  // Скамеры (основная база)
  db.exec(`
    CREATE TABLE IF NOT EXISTS scammers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      username TEXT,
      description TEXT NOT NULL DEFAULT '',
      photo_file_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Миграция: добавить колонки, если их ещё нет (до создания индексов)
  try {
    db.exec(`ALTER TABLE scammers ADD COLUMN full_name TEXT`);
  } catch (e) { /* уже есть */ }
  try {
    db.exec(`ALTER TABLE scammers ADD COLUMN photo_import_path TEXT`);
  } catch (e) { /* уже есть */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scammers_phone ON scammers(phone);
    CREATE INDEX IF NOT EXISTS idx_scammers_username ON scammers(LOWER(TRIM(username)));
  `);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scammers_full_name ON scammers(LOWER(TRIM(full_name)))`);
  } catch (e) { /* колонка может отсутствовать в старых БД до миграции */ }

  // Пользователи и подписки
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      subscription_until TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Лимит проверок для бесплатных: 1 в сутки
  db.exec(`
    CREATE TABLE IF NOT EXISTS check_usage (
      user_id INTEGER,
      date TEXT,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
  `);

  // Заявки на добавление скамера (от пользователей)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_scammers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      phone TEXT,
      username TEXT,
      description TEXT,
      photo_file_id TEXT,
      status TEXT DEFAULT 'pending',
      admin_comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
  `);

  // Платежи (заявки на подписку)
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount_usdt REAL,
      period TEXT,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',
      admin_comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
  `);

  // Мерчанты (честность работы): ник/тег, описание. Заполняется вручную и из заявок
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      tag TEXT,
      description TEXT NOT NULL DEFAULT '',
      photo_file_id TEXT,
      is_top INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_merchants_nickname ON merchants(LOWER(TRIM(nickname)));
    CREATE INDEX IF NOT EXISTS idx_merchants_tag ON merchants(LOWER(TRIM(tag)));
    CREATE INDEX IF NOT EXISTS idx_merchants_is_top ON merchants(is_top);
  `);

  // Заявки на добавление информации о мерчанте (пользователи → админ одобряет/отклоняет)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      nickname TEXT,
      description TEXT,
      photo_file_id TEXT,
      status TEXT DEFAULT 'pending',
      admin_comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
  `);

  db.close();
}

module.exports = { getDb, initDb };
