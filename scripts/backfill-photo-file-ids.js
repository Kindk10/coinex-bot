/**
 * Один раз запустить на ПК (где есть папка экспорта Telegram с фото).
 * Загружает фото в Telegram и сохраняет photo_file_id в БД.
 * После этого бот на сервере сможет отправлять эти фото (по file_id).
 *
 * Использование:
 *   node scripts/backfill-photo-file-ids.js
 *   или с путём к экспорту:
 *   EXPORT_BASE_PATH="C:\path\to\export" node scripts/backfill-photo-file-ids.js
 */
process.env.NTBA_FIX_350 = '1';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { getDb, initDb } = require('../db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_ID || '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n) && n > 0);
const EXPORT_BASE_PATH = process.env.EXPORT_BASE_PATH ||
  path.join('c:', 'Users', 'dkk150607', 'Downloads', 'Telegram Desktop', 'ChatExport_2026-02-22');

if (!BOT_TOKEN || ADMIN_IDS.length === 0) {
  console.error('Нужны BOT_TOKEN и ADMIN_ID в .env');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
initDb();

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const adminId = ADMIN_IDS[0];

const db = getDb();
const rows = db.prepare(`
  SELECT id, photo_import_path FROM scammers
  WHERE photo_import_path IS NOT NULL AND (photo_file_id IS NULL OR photo_file_id = '')
`).all();
db.close();

if (rows.length === 0) {
  console.log('Нет записей с photo_import_path без photo_file_id. Выход.');
  process.exit(0);
}

console.log(`Найдено записей для обновления: ${rows.length}`);
console.log(`Папка экспорта: ${EXPORT_BASE_PATH}\n`);

let updated = 0;
let skipped = 0;

(async () => {
  for (const row of rows) {
    const photoPath = path.isAbsolute(row.photo_import_path)
      ? row.photo_import_path
      : path.join(EXPORT_BASE_PATH, row.photo_import_path);

    if (!fs.existsSync(photoPath)) {
      console.log(`[пропуск] id=${row.id}: файл не найден ${photoPath}`);
      skipped++;
      continue;
    }

    try {
      const sent = await bot.sendPhoto(adminId, fs.createReadStream(photoPath), {
        caption: `[backfill] id=${row.id}`,
      });
      const fileId = sent.photo && sent.photo.length
        ? sent.photo[sent.photo.length - 1].file_id
        : null;
      if (fileId) {
        const db2 = getDb();
        db2.prepare('UPDATE scammers SET photo_file_id = ? WHERE id = ?').run(fileId, row.id);
        db2.close();
        updated++;
        process.stdout.write(`\rОбновлено: ${updated}, пропущено: ${skipped}`);
      }
    } catch (e) {
      console.error(`\n[ошибка] id=${row.id}:`, e.message);
      skipped++;
    }
  }

  console.log(`\n\nГотово. Обновлено: ${updated}, пропущено: ${skipped}`);
  console.log('Закоммитьте и запушьте data/bot.db, затем на сервере: git pull и systemctl restart coinex-bot');
})();
