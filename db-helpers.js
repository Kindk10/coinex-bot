const { getDb } = require('./db');

const WALLET_BEP20 = '0x37c62127256469c559d07c0d314463e28c2aef69';
const PRICE_MONTH_USDT = 15;
const PRICE_WEEK_USDT = 5;

function ensureUser(userId) {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO users (user_id) VALUES (?)'
  ).run(userId);
  db.close();
}

function hasActiveSubscription(userId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT subscription_until FROM users WHERE user_id = ?'
  ).get(userId);
  db.close();
  if (!row || !row.subscription_until) {
    return false;
  }
  // Парсим дату: формат "YYYY-MM-DD HH:MM:SS" -> преобразуем в ISO для правильного парсинга
  let untilStr = row.subscription_until;
  // Если формат "YYYY-MM-DD HH:MM:SS", заменяем пробел на T для ISO формата
  if (untilStr.includes(' ') && !untilStr.includes('T')) {
    untilStr = untilStr.replace(' ', 'T');
  }
  // Добавляем timezone если нет
  if (!untilStr.includes('Z') && !untilStr.includes('+') && !untilStr.includes('-', 10)) {
    untilStr += 'Z'; // UTC
  }
  const untilDate = new Date(untilStr);
  const now = new Date();
  const isActive = untilDate > now;
  return isActive;
}

function canMakeCheck(userId) {
  if (hasActiveSubscription(userId)) return { ok: true, limit: null };
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    'SELECT count FROM check_usage WHERE user_id = ? AND date = ?'
  ).get(userId, today);
  db.close();
  const count = row ? row.count : 0;
  const ok = count < 1;
  return { ok, limit: 1, used: count };
}

function recordCheck(userId) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO check_usage (user_id, date, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1`
  ).run(userId, today);
  db.close();
}

function normalizePhone(phone) {
  return phone ? String(phone).replace(/\D/g, '') : '';
}

function normalizeUsername(u) {
  return u ? String(u).replace(/^@/, '').trim().toLowerCase() : '';
}

// Экранирование % и _ для LIKE (SQLite ESCAPE '\')
function escapeLike(s) {
  if (s == null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

// Безопасная подготовка запроса: обрезаем длину, минимум 1 символ для поиска
function sanitizeSearchQuery(rawQuery) {
  const s = String(rawQuery || '').trim();
  if (s.length < 1) return '';
  return s.substring(0, 500);
}

// Разбить запрос на слова (для поиска по ФИО в любом порядке)
function queryToWords(queryText) {
  return String(queryText || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 1);
}

// Объединённый текст для поиска: full_name + description
function searchableText() {
  return "LOWER(TRIM(COALESCE(full_name,'') || ' ' || COALESCE(description,'')))";
}

// Варианты написания для кириллицы: а/я, о/а, е/э (чтобы "Табин" и "Тябин" находили друг друга)
function nameSearchVariants(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s || s.length < 2) return [s];
  const variants = new Set([s]);
  const pairs = [['а', 'я'], ['я', 'а'], ['о', 'а'], ['е', 'э'], ['э', 'е'], ['ё', 'е'], ['и', 'й'], ['й', 'и']];
  pairs.forEach(([a, b]) => {
    const v = s.split(a).join(b);
    if (v !== s) variants.add(v);
  });
  return Array.from(variants);
}

function findScammer(phone, username, fullNameQuery = null) {
  const rawQuery = phone || username || fullNameQuery || '';
  const queryText = sanitizeSearchQuery(rawQuery);
  
  if (!queryText) return [];
  
  const db = getDb();
  
  try {
    const likePattern = '%' + escapeLike(queryText) + '%';
    const likePatternLower = '%' + escapeLike(queryText.toLowerCase()) + '%';
    const queryDigits = queryText.replace(/\D/g, '');
    const likeDigits = queryDigits.length >= 2 ? '%' + escapeLike(queryDigits) + '%' : likePattern;
    
    const words = queryToWords(queryText);
    const searchable = searchableText();
    
    let sql;
    let params;
    
    if (words.length >= 2) {
      // Для каждого слова — варианты написания (а/я и т.д.), затем условие "все слова встречаются"
      const wordVariantPatterns = words.map(w => nameSearchVariants(w).map(v => '%' + escapeLike(v) + '%'));
      const fullNameConditions = wordVariantPatterns.map(patterns =>
        '(' + patterns.map(() => "LOWER(TRIM(COALESCE(full_name,''))) LIKE ? ESCAPE '\\'").join(' OR ') + ')'
      ).join(' AND ');
      const descConditions = wordVariantPatterns.map(patterns =>
        '(' + patterns.map(() => "LOWER(COALESCE(description,'')) LIKE ? ESCAPE '\\'").join(' OR ') + ')'
      ).join(' AND ');
      const combinedConditions = wordVariantPatterns.map(patterns =>
        '(' + patterns.map(() => `(${searchable}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')'
      ).join(' AND ');
      const flatPatterns = wordVariantPatterns.flat();
      
      sql = `
        SELECT * FROM scammers WHERE
        (COALESCE(phone,'') != '' AND (phone LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),'+',''),' ',''),'-',''),'(',''),')','') LIKE ? ESCAPE '\\'))
        OR (COALESCE(username,'') != '' AND LOWER(TRIM(REPLACE(COALESCE(username,''),'@',''))) LIKE ? ESCAPE '\\')
        OR (LOWER(TRIM(COALESCE(full_name,''))) LIKE ? ESCAPE '\\' OR (${fullNameConditions}))
        OR (LOWER(COALESCE(description,'')) LIKE ? ESCAPE '\\' OR (${descConditions}))
        OR (${combinedConditions})
      `;
      params = [
        likePattern,
        likeDigits,
        likePatternLower,
        likePatternLower,
        likePatternLower,
        ...flatPatterns,
        ...flatPatterns,
        ...flatPatterns
      ];
    } else {
      // Одна фраза или слово: ищем в phone, username, full_name, description, объединённом поле
      // + варианты написания (а/я, о/а и т.д.) для кириллических имён
      const variants = nameSearchVariants(queryText);
      const variantPatterns = variants.map(v => '%' + escapeLike(v) + '%');
      const likeFullName = variantPatterns.map(() => "LOWER(TRIM(COALESCE(full_name,''))) LIKE ? ESCAPE '\\'").join(' OR ');
      const likeDesc = variantPatterns.map(() => "LOWER(COALESCE(description,'')) LIKE ? ESCAPE '\\'").join(' OR ');
      const likeCombined = variantPatterns.map(() => `(${searchable}) LIKE ? ESCAPE '\\'`).join(' OR ');
      
      sql = `
        SELECT * FROM scammers WHERE
        (COALESCE(phone,'') != '' AND (phone LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),'+',''),' ',''),'-',''),'(',''),')','') LIKE ? ESCAPE '\\'))
        OR (COALESCE(username,'') != '' AND LOWER(TRIM(REPLACE(COALESCE(username,''),'@',''))) LIKE ? ESCAPE '\\')
        OR (${likeFullName})
        OR (${likeDesc})
        OR (${likeCombined})
      `;
      params = [
        likePattern,
        likeDigits,
        likePatternLower,
        ...variantPatterns,
        ...variantPatterns,
        ...variantPatterns
      ];
    }
    
    const rows = db.prepare(sql).all(...params);
    db.close();
    
    // Убираем дубликаты по id (могут появиться при нескольких OR)
    const seen = new Set();
    const unique = rows.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    
    console.log(`[findScammer] Query: "${queryText.substring(0, 50)}", Found: ${unique.length} results`);
    return unique;
  } catch (e) {
    db.close();
    console.error('[findScammer] Error:', e.message);
    return [];
  }
}

function addPendingScammer(data) {
  const db = getDb();
  const id = db.prepare(`
    INSERT INTO pending_scammers (user_id, user_name, phone, username, description, photo_file_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.userName || '',
    data.phone || null,
    data.username || null,
    data.description || '',
    data.photoFileId || null
  ).lastInsertRowid;
  db.close();
  return id;
}

function getPendingScammer(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pending_scammers WHERE id = ?').get(id);
  db.close();
  return row;
}

function setPendingScammerStatus(id, status, adminComment) {
  const db = getDb();
  db.prepare(`
    UPDATE pending_scammers SET status = ?, admin_comment = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, adminComment || null, id);
  db.close();
}

function addScammerFromPending(pending) {
  const db = getDb();
  db.prepare(`
    INSERT INTO scammers (phone, username, description, photo_file_id)
    VALUES (?, ?, ?, ?)
  `).run(
    pending.phone || null,
    pending.username || null,
    pending.description || '',
    pending.photo_file_id || null
  );
  db.close();
}

function addPayment(data) {
  const db = getDb();
  const id = db.prepare(`
    INSERT INTO payments (user_id, amount_usdt, period, tx_hash, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(data.userId, data.amountUsdt, data.period, data.txHash || null).lastInsertRowid;
  db.close();
  return id;
}

function getPayment(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  db.close();
  return row;
}

function setPaymentStatus(id, status, adminComment) {
  const db = getDb();
  db.prepare(`
    UPDATE payments SET status = ?, admin_comment = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, adminComment || null, id);
  db.close();
}

function grantSubscription(userId, period) {
  const db = getDb();
  ensureUser(userId);
  const until = new Date();
  if (period === 'month') {
    until.setMonth(until.getMonth() + 1);
  } else if (period === 'week') {
    until.setDate(until.getDate() + 7);
  } else {
    // По умолчанию месяц
    until.setMonth(until.getMonth() + 1);
  }
  // Формат: YYYY-MM-DD HH:MM:SS (SQLite datetime, ISO 8601 совместимый)
  const untilStr = until.toISOString().slice(0, 19).replace('T', ' ');
  const stmt = db.prepare('UPDATE users SET subscription_until = ? WHERE user_id = ?');
  const result = stmt.run(untilStr, userId);
  db.close();
  console.log(`[grantSubscription] User ${userId}, period: ${period}, until: ${untilStr}, rows updated: ${result.changes}`);
  
  // Проверяем что записалось
  const db2 = getDb();
  const check = db2.prepare('SELECT subscription_until FROM users WHERE user_id = ?').get(userId);
  db2.close();
  console.log(`[grantSubscription] Verified: user ${userId} subscription_until = ${check?.subscription_until}`);
  
  return untilStr;
}

function getAllPendingScammers() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pending_scammers WHERE status = ? ORDER BY id DESC').all('pending');
  db.close();
  return rows;
}

function getAllPendingPayments() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY id DESC').all('pending');
  db.close();
  return rows;
}

function addScammerManual(phone, username, description, photoFileId, fullName = null, photoImportPath = null) {
  const db = getDb();
  const id = db.prepare(`
    INSERT INTO scammers (phone, username, full_name, description, photo_file_id, photo_import_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    phone || null,
    username || null,
    fullName || null,
    description || '',
    photoFileId || null,
    photoImportPath || null
  ).lastInsertRowid;
  db.close();
  return id;
}

// ——— Мерчанты ———
function findMerchant(nicknameOrTag) {
  const db = getDb();
  const q = String(nicknameOrTag || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) {
    db.close();
    return null;
  }
  const row = db.prepare(`
    SELECT * FROM merchants
    WHERE LOWER(TRIM(REPLACE(nickname,'@',''))) = ? OR LOWER(TRIM(REPLACE(COALESCE(tag,''),'@',''))) = ?
    LIMIT 1
  `).get(q, q);
  db.close();
  return row || null;
}

function findMerchantByPartial(nicknameOrTag) {
  const db = getDb();
  const q = String(nicknameOrTag || '').trim().toLowerCase().replace(/^@/, '');
  if (!q || q.length < 2) {
    db.close();
    return [];
  }
  const like = '%' + q.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  const rows = db.prepare(`
    SELECT * FROM merchants
    WHERE LOWER(TRIM(REPLACE(nickname,'@',''))) LIKE ? ESCAPE '\\'
       OR LOWER(TRIM(REPLACE(COALESCE(tag,''),'@',''))) LIKE ? ESCAPE '\\'
    ORDER BY is_top DESC
  `).all(like, like);
  db.close();
  return rows;
}

function getTopMerchants() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM merchants WHERE is_top = 1 ORDER BY id DESC').all();
  db.close();
  return rows;
}

function addMerchantManual(nickname, tag, description, photoFileId, isTop = 0) {
  const db = getDb();
  const id = db.prepare(`
    INSERT INTO merchants (nickname, tag, description, photo_file_id, is_top)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(nickname || '').trim(),
    tag ? String(tag).trim() : null,
    description || '',
    photoFileId || null,
    isTop ? 1 : 0
  ).lastInsertRowid;
  db.close();
  return id;
}

function setMerchantTop(merchantId, isTop) {
  const db = getDb();
  db.prepare('UPDATE merchants SET is_top = ? WHERE id = ?').run(isTop ? 1 : 0, merchantId);
  db.close();
}

function addPendingMerchant(data) {
  const db = getDb();
  const id = db.prepare(`
    INSERT INTO pending_merchants (user_id, user_name, nickname, description, photo_file_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.userName || '',
    data.nickname || null,
    data.description || '',
    data.photoFileId || null
  ).lastInsertRowid;
  db.close();
  return id;
}

function getPendingMerchant(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pending_merchants WHERE id = ?').get(id);
  db.close();
  return row;
}

function setPendingMerchantStatus(id, status, adminComment) {
  const db = getDb();
  db.prepare(`
    UPDATE pending_merchants SET status = ?, admin_comment = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, adminComment || null, id);
  db.close();
}

function addMerchantFromPending(pending) {
  const db = getDb();
  db.prepare(`
    INSERT INTO merchants (nickname, tag, description, photo_file_id, is_top)
    VALUES (?, ?, ?, ?, 0)
  `).run(
    pending.nickname || '',
    (pending.tag && String(pending.tag).trim()) || pending.nickname || null,
    pending.description || '',
    pending.photo_file_id || null
  );
  db.close();
}

function getAllPendingMerchants() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pending_merchants WHERE status = ? ORDER BY id DESC').all('pending');
  db.close();
  return rows;
}

function getMerchant(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
  db.close();
  return row;
}

module.exports = {
  WALLET_BEP20,
  PRICE_MONTH_USDT,
  PRICE_WEEK_USDT,
  normalizePhone,
  normalizeUsername,
  ensureUser,
  hasActiveSubscription,
  canMakeCheck,
  recordCheck,
  findScammer,
  addPendingScammer,
  getPendingScammer,
  setPendingScammerStatus,
  addScammerFromPending,
  addPayment,
  getPayment,
  setPaymentStatus,
  grantSubscription,
  getAllPendingScammers,
  getAllPendingPayments,
  addScammerManual,
  findMerchant,
  findMerchantByPartial,
  getTopMerchants,
  addMerchantManual,
  setMerchantTop,
  addPendingMerchant,
  getPendingMerchant,
  setPendingMerchantStatus,
  addMerchantFromPending,
  getAllPendingMerchants,
  getMerchant,
};
