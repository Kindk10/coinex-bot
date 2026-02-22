const path = require('path');
const fs = require('fs');
const db = require('../db');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
db.initDb();
console.log('База данных инициализирована: data/bot.db');
