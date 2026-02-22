const fs = require('fs');
const path = require('path');
const { getDb, initDb } = require('../db');
const { addScammerManual, normalizePhone, normalizeUsername, findScammer } = require('../db-helpers');

// Инициализируем БД если нужно
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
initDb();

const HTML_FILE = process.argv[2] || 'c:\\Users\\dkk150607\\Downloads\\Telegram Desktop\\ChatExport_2026-02-22\\messages.html';

if (!fs.existsSync(HTML_FILE)) {
  console.error(`Файл не найден: ${HTML_FILE}`);
  console.error('Использование: node scripts/import-scammers.js [путь_к_messages.html]');
  process.exit(1);
}

console.log(`Читаю файл: ${HTML_FILE}`);

const html = fs.readFileSync(HTML_FILE, 'utf-8');

// Регулярные выражения
const USERNAME_REGEX = /@(\w+)/gi;
const PHONE_REGEX = /(?:tel:|href="tel:)?(\+?\d[\d\s\-\(\)]{7,})/gi;
const TELEGRAM_LINK_REGEX = /t\.me\/(\w+)/gi;
const COINEX_LINK_REGEX = /coinex\.com\/[^\s"<>]+/gi;
// ФИО: полное (2–4 слова), только имя+фамилия, только имя, инициалы (И.И. / И. Иванов / А.С. Гнутов)
const FIO_FULL_REGEX = /(?:^|[\s,])([А-ЯЁA-Z][а-яёa-z]+\s+[А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)(?=[\s,]|$)/g;
const FIO_ONE_NAME_REGEX = /(?:^|[\s,])([А-ЯЁA-Z][а-яёa-z]{2,})(?=[\s,]|$)/g;
const FIO_INITIALS_REGEX = /(?:^|[\s,])([А-ЯЁA-Z]\.[А-ЯЁA-Z]?\.?(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)(?=[\s,]|$)/g;
// Путь к фото в экспорте Telegram
const PHOTO_HREF_REGEX = /href="(chats\/[^"]+\.(?:jpg|jpeg|png|webp))"/i;

const SKIP_USERNAMES = new Set(['user', 'userinfobot', 'SolidXchange', 'coinexeye_bot']);

let count = 0;
let added = 0;
let skipped = 0;

const messageBlocks = html.split(/<div class="message default clearfix"/);
const messages = [];

for (let i = 1; i < messageBlocks.length; i++) {
  const block = messageBlocks[i];
  if (!block.includes('go_to_message157')) continue;
  const textMatch = block.match(/<div class="text">([\s\S]*?)<\/div>/);
  if (!textMatch || !textMatch[1]) continue;
  const textContent = textMatch[1];
  if (textContent.includes('In reply to')) continue;
  messages.push(block);
}

console.log(`Найдено сообщений в топике "Скамеры": ${messages.length}`);

for (const msgBlock of messages) {
  count++;

  const textMatch = msgBlock.match(/<div class="text">([\s\S]*?)<\/div>/);
  const msgHtml = textMatch ? textMatch[1] : '';
  const text = msgHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '"')
    .replace(/&raquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  // Извлечение пути к фото из сообщения
  const photoMatch = msgBlock.match(PHOTO_HREF_REGEX);
  const photoImportPath = photoMatch ? photoMatch[1] : null;

  // Ссылки coinex.com
  const coinexLinks = [];
  let m;
  while ((m = COINEX_LINK_REGEX.exec(msgBlock)) !== null) {
    if (!coinexLinks.includes(m[0])) coinexLinks.push(m[0]);
  }
  COINEX_LINK_REGEX.lastIndex = 0;

  // Никнеймы из t.me и @
  const usernames = [];
  while ((m = TELEGRAM_LINK_REGEX.exec(msgBlock)) !== null) {
    usernames.push(m[1].toLowerCase());
  }
  TELEGRAM_LINK_REGEX.lastIndex = 0;
  while ((m = USERNAME_REGEX.exec(text)) !== null) {
    const u = m[1].toLowerCase();
    if (!SKIP_USERNAMES.has(u) && !usernames.includes(u)) usernames.push(u);
  }
  USERNAME_REGEX.lastIndex = 0;

  // Теги в скобках типа "username (user123)" — уже ловим через @
  // Номера телефонов
  const phones = [];
  while ((m = PHONE_REGEX.exec(msgBlock)) !== null) {
    const p = normalizePhone(m[1]);
    if (p && p.length >= 10 && !phones.includes(p)) phones.push(p);
  }
  PHONE_REGEX.lastIndex = 0;
  const phoneInText = text.match(/\b\d{10,15}\b/g);
  if (phoneInText) {
    for (const p of phoneInText) {
      const norm = normalizePhone(p);
      if (norm && norm.length >= 10 && !phones.includes(norm)) phones.push(norm);
    }
  }

  // ФИО: полное, имя+фамилия, одно имя, инициалы
  const fioList = [];
  const addFio = (name) => {
    const n = (name || '').trim();
    if (n.length >= 2 && !fioList.includes(n)) fioList.push(n);
  };
  while ((m = FIO_FULL_REGEX.exec(text)) !== null) addFio(m[1]);
  FIO_FULL_REGEX.lastIndex = 0;
  while ((m = FIO_INITIALS_REGEX.exec(text)) !== null) addFio(m[1]);
  FIO_INITIALS_REGEX.lastIndex = 0;
  while ((m = FIO_ONE_NAME_REGEX.exec(text)) !== null) addFio(m[1]);
  FIO_ONE_NAME_REGEX.lastIndex = 0;
  // Приоритет: полное ФИО (с пробелами) > инициалы > одно имя
  const fullName = fioList.length > 0
    ? fioList.sort((a, b) => (b.match(/\s/g) || []).length - (a.match(/\s/g) || []).length)[0]
    : null;

  // Не пропускаем ни одного сообщения — добавляем все
  const hasAnyData = phones.length > 0 || usernames.length > 0 || coinexLinks.length > 0 || fullName || photoImportPath;
  const hasText = text && text.trim().length > 0;

  // Описание: весь текст, убираем только служебное
  let description = text
    .replace(/In reply to.*?this message/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (coinexLinks.length > 0) {
    description = (description ? description + ' ' : '') + coinexLinks.join(', ');
  }
  if (description.length < 2) description = '';

  // Идентификаторы для записи
  let phone = phones.length > 0 ? phones[0] : null;
  let username = usernames.length > 0 ? usernames[0] : null;
  if (!username && coinexLinks.length > 0) {
    const idMatch = coinexLinks[0].match(/\/([A-Z0-9]+)$/i);
    if (idMatch) username = 'coinex_' + idMatch[1].toLowerCase();
  }
  if (!username && !phone && fullName) {
    username = 'fio_' + fullName.replace(/\s+/g, '_').toLowerCase().substring(0, 50);
  }
  // Если нет идентификаторов, создаём из описания или текста
  if (!username && !phone && description.length > 5) {
    // Используем первые слова описания как идентификатор
    const descWords = description.split(/\s+/).slice(0, 3).join('_').toLowerCase().substring(0, 50);
    username = 'msg_' + descWords.replace(/[^a-zа-яё0-9_]/g, '');
  }
  if (!username && !phone && text.length > 5) {
    const textWords = text.split(/\s+/).slice(0, 2).join('_').toLowerCase().substring(0, 30);
    username = 'txt_' + textWords.replace(/[^a-zа-яё0-9_]/g, '');
  }
  // Уникальный идентификатор для каждого сообщения (чтобы добавить все подряд)
  if (!username && !phone) {
    username = 'msg_' + count;
  }
  
  // Добавляем ВСЕ сообщения без исключений
  description = description || text.substring(0, 1000) || '(сообщение без текста)';

  try {
    addScammerManual(phone, username, description, null, fullName, photoImportPath);
    added++;
    if (added % 10 === 0) {
      process.stdout.write(`\rОбработано: ${count}/${messages.length}, добавлено: ${added}, пропущено: ${skipped}`);
    }
  } catch (e) {
    console.error(`\nОшибка при добавлении сообщения #${count}: ${e.message}`);
    console.error(`  Данные: phone=${phone}, username=${username}, desc_len=${description.length}`);
    skipped++;
  }
}

console.log(`\n\nГотово!`);
console.log(`Всего сообщений обработано: ${count}`);
console.log(`Добавлено скамеров: ${added}`);
console.log(`Пропущено: ${skipped}`);
