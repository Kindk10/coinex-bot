// Убирает DeprecationWarning при отправке фото/файлов (node-telegram-bot-api)
process.env.NTBA_FIX_350 = '1';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const {
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
  WALLET_BEP20,
  PRICE_MONTH_USDT,
  PRICE_WEEK_USDT,
} = require('./db-helpers');

const BOT_TOKEN = process.env.BOT_TOKEN;
// Поддержка нескольких админов: ADMIN_ID=123,456 или один 123
const ADMIN_IDS = (process.env.ADMIN_ID || '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n) && n > 0);
const ADMIN_ID = ADMIN_IDS[0] || 0; // для обратной совместимости (уведомления в одного админа можно заменить на рассылку)

if (!BOT_TOKEN) {
  console.error('Укажите BOT_TOKEN в .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: { allowed_updates: ['message', 'callback_query'] },
  },
});

const userState = new Map();

function setState(userId, state, data = {}) {
  userState.set(userId, { state, data });
}

function getState(userId) {
  return userState.get(userId);
}

function clearState(userId) {
  userState.delete(userId);
}

function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔍 Проверить скамера', callback_data: 'check' }],
        [{ text: '➕ Добавить скамера в список', callback_data: 'add_scammer' }],
        [{ text: '🛒 Проверить мерчанта', callback_data: 'check_merchant' }],
        [{ text: '📝 Добавить информацию о мерчанте', callback_data: 'add_merchant_info' }],
        [{ text: '🏆 Топ лучших мерчантов', callback_data: 'top_merchants' }],
        [{ text: '💳 Подписка (безлимит проверок)', callback_data: 'subscription' }],
        [{ text: '📋 Моя подписка', callback_data: 'my_sub' }],
      ],
    },
  };
}

function subscriptionKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ В меню', callback_data: 'menu' }],
      ],
    },
  };
}

// Постоянная кнопка внизу экрана для пользователя
const MAIN_MENU_BUTTON = '📋 Главное меню';
function mainMenuReplyKeyboard() {
  return {
    reply_markup: {
      keyboard: [[MAIN_MENU_BUTTON]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function isAdmin(userId) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId);
}

function getAdminIds() {
  return ADMIN_IDS;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  ensureUser(userId);

  const showMainMenu = async () => {
    await bot.sendMessage(
      chatId,
      '👋 Добро пожаловать в *CoinEX_SkamerList*.\n\n' +
      'Здесь можно:\n' +
      '• Проверить контакт по номеру или нику — есть ли он в списке скамеров\n' +
      '• Отправить заявку на добавление нового скамера (без ограничений)\n' +
      '• Оформить подписку для неограниченных проверок\n\n' +
      'Выберите действие:',
      { parse_mode: 'Markdown', ...mainMenu() }
    );
    await bot.sendMessage(chatId, '⬇️ Главное меню', mainMenuReplyKeyboard());
  };

  if (text === '/start' || text === MAIN_MENU_BUTTON || text === 'Главное меню') {
    await showMainMenu();
    return;
  }

  if (text === '/paid' || (text.startsWith('/paid') && text.replace(/^\/paid\s*/, '').trim() === '')) {
    if (!msg.photo) {
      await bot.sendMessage(
        chatId,
        '💳 *Оплата подписки*\n\n' +
        `Сеть: *BEP20*\nАдрес кошелька:\n\`${WALLET_BEP20}\`\n\n` +
        'Тарифы:\n' +
        `• Неделя — *${PRICE_WEEK_USDT} USDT*\n` +
        `• Месяц — *${PRICE_MONTH_USDT} USDT*\n\n` +
        'После перевода отправьте сюда хэш транзакции (или скрин). Например:\n' +
        '`/paid 0x123...` или приложите скриншот к сообщению.',
        { parse_mode: 'Markdown', ...subscriptionKeyboard() }
      );
    }
    return;
  }

  if (text.startsWith('/paid ') || (text.startsWith('/paid') && text.length > 5)) {
    const rest = text.replace(/^\/paid\s*/, '').trim();
    ensureUser(userId);
    const paymentId = addPayment({ userId, amountUsdt: null, period: 'manual', txHash: rest || null });
    
    // Автоматическое подтверждение для тестовых платежей (начинаются с "test")
    if (rest && rest.toLowerCase().startsWith('test') && isAdmin(userId)) {
      console.log(`[auto-approve] Auto-approving test payment #${paymentId} for admin`);
      setPaymentStatus(paymentId, 'confirmed');
      const until = grantSubscription(userId, 'month');
      await bot.sendMessage(chatId, `✅ Тестовая оплата автоматически подтверждена! Подписка активна до ${until}.`, mainMenu());
      return;
    }
    
    await notifyAdminNewPayment(paymentId, userId, msg, rest);
    
    // Если это админ, добавляем кнопку для быстрого подтверждения
    if (isAdmin(userId)) {
      await bot.sendMessage(
        chatId,
        `Заявка на оплату #${paymentId} отправлена.\n\n` +
        `Вы админ. Для подтверждения отправьте:\n` +
        `\`/approve_payment ${paymentId} month\`\n` +
        `или \`/approve_payment ${paymentId} week\``,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    } else {
      await bot.sendMessage(chatId, 'Заявка на оплату отправлена. Ожидайте подтверждения.', mainMenu());
    }
    return;
  }

  const state = getState(userId);

  if (state?.state === 'await_check') {
    clearState(userId);
    const input = text.trim();
    if (!input || input.length < 2) {
      await bot.sendMessage(
        chatId,
        'Введите номер, ник, ФИО, часть текста или *ссылку* (например coinex.com или t.me).\n\n' +
        'Поиск: от 2 символов, по всем полям. Поддерживается поиск по ссылкам.',
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }

    const { ok, used, limit } = canMakeCheck(userId);
    if (!ok) {
      await bot.sendMessage(
        chatId,
        `❌ Лимит бесплатных проверок исчерпан (${used}/${limit} в сутки). Оформите подписку для безлимита.`,
        mainMenu()
      );
      return;
    }

    recordCheck(userId);
    
    let list = [];
    try {
      list = findScammer(input, input, input);
    } catch (e) {
      console.error('[check] findScammer error:', e);
      await bot.sendMessage(chatId, 'Ошибка поиска. Попробуйте другой запрос (без спецсимволов или короче).', mainMenu());
      return;
    }
    
    if (list.length === 0) {
      await bot.sendMessage(
        chatId,
        '✅ В списке скамеров совпадений *не найдено*.',
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }
    
    const buildReply = (s) => {
      const parts = [s.phone, s.username, s.full_name].filter(Boolean);
      let r = '⚠️ Найдено в списке скамеров:\n\n• ' + (parts.join(' / ') || '—') + '\n';
      if (s.description) r += '\n' + String(s.description).substring(0, 900);
      if (s.photo_import_path && !s.photo_file_id) r += '\n(есть фото в экспорте)';
      return r.substring(0, 1024);
    };
    
    for (const s of list) {
      const replyText = buildReply(s);
      let sent = false;
      
      if (s.photo_file_id) {
        try {
          await bot.sendPhoto(chatId, s.photo_file_id, {
            caption: replyText,
            reply_markup: mainMenu().reply_markup
          });
          sent = true;
        } catch (e) {
          console.error(`[check] sendPhoto file_id:`, e.message);
        }
      }
      
      if (!sent && s.photo_import_path) {
        const fs = require('fs');
        const path = require('path');
        const exportBasePath = process.env.EXPORT_BASE_PATH || 'c:\\Users\\dkk150607\\Downloads\\Telegram Desktop\\ChatExport_2026-02-22';
        const photoPath = path.isAbsolute(s.photo_import_path) ? s.photo_import_path : path.join(exportBasePath, s.photo_import_path);
        if (fs.existsSync(photoPath)) {
          try {
            await bot.sendPhoto(chatId, fs.createReadStream(photoPath), {
              caption: replyText,
              reply_markup: mainMenu().reply_markup
            });
            sent = true;
          } catch (e) {
            console.error(`[check] sendPhoto path:`, e.message);
          }
        }
      }
      
      if (!sent) {
        await bot.sendMessage(chatId, replyText, mainMenu());
      }
    }
    return;
  }

  if (state?.state === 'await_merchant_check') {
    const query = text.replace(/^@/, '').trim();
    if (query.length < 2) {
      await bot.sendMessage(chatId, 'Введите ник или тег мерчанта (от 2 символов).');
      return;
    }
    clearState(userId);
    const exact = findMerchant(query);
    const byPartial = findMerchantByPartial(query);
    if (exact) {
      const m = exact;
      const replyText =
        `🛒 *Мерчант: ${(m.nickname || m.tag || '—').replace(/\*/g, '')}*\n\n` +
        (m.description || 'Описание отсутствует.').replace(/\*/g, '');
      let sent = false;
      if (m.photo_file_id) {
        try {
          await bot.sendPhoto(chatId, m.photo_file_id, {
            caption: replyText,
            parse_mode: 'Markdown',
            reply_markup: mainMenu().reply_markup,
          });
          sent = true;
        } catch (e) {
          console.error('[merchant] sendPhoto:', e.message);
        }
      }
      if (!sent) await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown', ...mainMenu() });
      return;
    }
    if (byPartial && byPartial.length > 0) {
      const list = byPartial
        .slice(0, 5)
        .map(
          (m) =>
            `• ${(m.nickname || m.tag || '—').replace(/\*/g, '')}: ${(m.description || '').slice(0, 80).replace(/\*/g, '')}${(m.description || '').length > 80 ? '…' : ''}`
        )
        .join('\n');
      await bot.sendMessage(
        chatId,
        `Найдено по запросу «${query.replace(/\*/g, '')}»:\n\n${list}\n\nВведите точный ник/тег для полного описания.`,
        mainMenu()
      );
      return;
    }
    await bot.sendMessage(chatId, `По запросу «${query.replace(/\*/g, '')}» мерчант не найден.`, mainMenu());
    return;
  }

  if (state?.state === 'add_merchant_nick') {
    const nick = text.replace(/^@/, '').trim();
    if (!nick || nick.length < 2) {
      await bot.sendMessage(chatId, 'Введите ник или тег мерчанта (от 2 символов).');
      return;
    }
    setState(userId, 'add_merchant_desc', { nickname: nick });
    await bot.sendMessage(chatId, 'Напишите описание мерчанта (честность работы, опыт и т.д.):');
    return;
  }

  if (state?.state === 'add_merchant_desc') {
    const data = state.data || {};
    setState(userId, 'add_merchant_photo', { ...data, description: text });
    await bot.sendMessage(
      chatId,
      'Описание сохранено. При желании прикрепите фото или нажмите «Пропустить».',
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Пропустить', callback_data: 'add_merchant_photo_skip' }]],
        },
      }
    );
    return;
  }

  if (state?.state === 'add_phone_nick') {
    const input = text;
    const hasDigit = /\d/.test(input);
    const hasLetter = /[a-zA-Zа-яА-Я_]/.test(input);
    if (!input || (!hasDigit && !hasLetter)) {
      await bot.sendMessage(chatId, 'Укажите номер телефона и/или ник (хотя бы что-то одно).');
      return;
    }
    setState(userId, 'add_description', {
      phone: hasDigit ? input : null,
      username: hasLetter ? input : null,
    });
    await bot.sendMessage(chatId, 'Напишите описание: что делает этот скамер.');
    return;
  }

  if (state?.state === 'add_description') {
    const data = state.data || {};
    setState(userId, 'add_photo', { ...data, description: text });
    await bot.sendMessage(
      chatId,
      'Описание сохранено. При желании прикрепите фото скамера (одним сообщением). Или нажмите «Пропустить».',
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Пропустить', callback_data: 'add_photo_skip' }]],
        },
      }
    );
    return;
  }

  if (text && !state && !text.startsWith('/')) {
    await bot.sendMessage(chatId, 'Выберите действие в меню:', mainMenu());
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = getState(userId);
  const photo = msg.photo;
  const fileId = photo && photo.length ? photo[photo.length - 1].file_id : null;

  if (state?.state === 'add_photo' && fileId) {
    const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || '';
    const data = { ...state.data, photoFileId: fileId, userId, userName };
    clearState(userId);
    const pid = addPendingScammer({
      userId,
      userName,
      phone: data.phone || null,
      username: data.username || null,
      description: data.description || '',
      photoFileId: fileId,
    });
    await bot.sendMessage(
      chatId,
      '✅ Заявка на добавление скамера отправлена. После проверки мы добавим его в список.',
      mainMenu()
    );
    await notifyAdminNewScammer(pid, data, fileId);
    return;
  }

  if (state?.state === 'add_merchant_photo' && fileId) {
    const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || '';
    const data = { ...state.data, photoFileId: fileId, userId, userName };
    clearState(userId);
    const pid = addPendingMerchant({
      userId,
      userName,
      nickname: data.nickname || null,
      description: data.description || '',
      photoFileId: fileId,
    });
    await bot.sendMessage(
      chatId,
      '✅ Заявка на добавление информации о мерчанте отправлена. После проверки мы добавим её в базу.',
      mainMenu()
    );
    await notifyAdminNewMerchant(pid, data, fileId);
    return;
  }

  if (state?.state === 'add_photo') return;
  if (state?.state === 'add_merchant_photo') return;

  if (msg.caption && msg.caption.trim().toLowerCase().startsWith('/paid')) {
    const paymentId = await createPaymentFromMessage(userId, msg, null);
    if (paymentId) await bot.sendMessage(chatId, 'Заявка на оплату отправлена. Ожидайте подтверждения.', mainMenu());
  }
});

async function notifyAdminNewScammer(pendingId, data, photoFileId) {
  const adminIds = getAdminIds();
  if (!adminIds.length) return;
  const text =
    `🆕 *Новая заявка на скамера* #${pendingId}\n` +
    `От: ${data.userName || '—'} (ID: ${data.userId})\n` +
    `Телефон: ${data.phone || '—'}\n` +
    `Ник: ${data.username || '—'}\n` +
    `Описание: ${data.description || '—'}\n\n` +
    `Подтвердить: /approve_scammer ${pendingId}\n` +
    `Отклонить: /reject_scammer ${pendingId}`;
  for (const adminId of adminIds) {
    try {
      if (photoFileId) {
        await bot.sendPhoto(adminId, photoFileId, { caption: text, parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error('Notify admin scammer:', e.message);
    }
  }
}

async function notifyAdminNewPayment(paymentId, userId, msg, txHash) {
  const adminIds = getAdminIds();
  console.log(`[notifyAdminNewPayment] Payment #${paymentId}, user ${userId}, admins: ${adminIds.join(',')}`);
  if (!adminIds.length) {
    console.error('[notifyAdminNewPayment] ADMIN_ID not set!');
    return;
  }
  const from = msg.from;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || userId;
  const txHashText = txHash || msg.caption || '—';
  const text =
    `💳 Новая заявка на оплату #${paymentId}\n` +
    `Пользователь: ${name} (ID: ${userId})\n` +
    `Хэш/комментарий: ${txHashText}\n\n` +
    `Подтвердить: /approve_payment ${paymentId} month\n` +
    `Отклонить: /reject_payment ${paymentId}\n\n` +
    `Или: /approve_payment ${paymentId} week для недельной подписки`;
  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(adminId, text);
      console.log(`[notifyAdminNewPayment] Message sent to admin ${adminId}`);
    } catch (e) {
      console.error(`[notifyAdminNewPayment] Failed to send to admin ${adminId}:`, e.message);
    }
  }
}

async function notifyAdminNewMerchant(pendingId, data, photoFileId) {
  const adminIds = getAdminIds();
  if (!adminIds.length) return;
  const text =
    `🛒 *Новая заявка: информация о мерчанте* #${pendingId}\n` +
    `От: ${data.userName || '—'} (ID: ${data.userId})\n` +
    `Ник/тег: ${data.nickname || '—'}\n` +
    `Описание: ${(data.description || '—').slice(0, 500)}\n\n` +
    `Одобрить: /approve_merchant ${pendingId}\n` +
    `Отклонить: /reject_merchant ${pendingId}`;
  for (const adminId of adminIds) {
    try {
      if (photoFileId) {
        await bot.sendPhoto(adminId, photoFileId, { caption: text, parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error('Notify admin merchant:', e.message);
    }
  }
}

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (data === 'menu') {
    clearState(userId);
    await bot.editMessageText('Выберите действие:', {
      chat_id: chatId,
      message_id: query.message?.message_id,
      ...mainMenu(),
    }).catch(() => bot.sendMessage(chatId, 'Выберите действие:', mainMenu()));
    return;
  }

  if (data === 'check') {
    setState(userId, 'await_check', {});
    await bot.sendMessage(
      chatId,
      'Введите данные для проверки (от 2 символов):\n\n' +
      '• Номер телефона или часть номера\n' +
      '• Ник (например @username)\n' +
      '• ФИО или часть имени\n' +
      '• Ссылку (coinex.com, t.me и т.д.)\n\n' +
      'Поддерживается поиск по ссылкам. Совпадение по любому полю — вам придут все найденные сообщения, с фото если есть.'
    );
    return;
  }

  if (data === 'add_scammer') {
    setState(userId, 'add_phone_nick', {});
    await bot.sendMessage(chatId, 'Введите номер телефона и/или ник скамера (хотя бы что-то одно):');
    return;
  }

  if (data === 'check_merchant') {
    setState(userId, 'await_merchant_check', {});
    await bot.sendMessage(
      chatId,
      'Введите ник или тег мерчанта (от 2 символов), чтобы проверить честность работы. Например: @nickname или nickname.'
    );
    return;
  }

  if (data === 'add_merchant_info') {
    setState(userId, 'add_merchant_nick', {});
    await bot.sendMessage(chatId, 'Введите ник или тег мерчанта (от 2 символов):');
    return;
  }

  if (data === 'top_merchants') {
    const top = getTopMerchants();
    if (!top || top.length === 0) {
      await bot.sendMessage(
        chatId,
        '🏆 Топ лучших мерчантов пока пуст. Список формируется администрацией.',
        mainMenu()
      );
      return;
    }
    const lines = top.map((m, i) => {
      const nick = (m.nickname || m.tag || '—').replace(/\*/g, '');
      const desc = (m.description || '').slice(0, 100).replace(/\*/g, '');
      const fullDesc = m.description || '';
      return `${i + 1}. *${nick}*${desc ? '\n   ' + desc + (fullDesc.length > 100 ? '…' : '') : ''}`;
    });
    await bot.sendMessage(
      chatId,
      '🏆 *Топ лучших мерчантов:*\n\n' + lines.join('\n\n'),
      { parse_mode: 'Markdown', ...mainMenu() }
    );
    return;
  }

  if (data === 'add_merchant_photo_skip') {
    const state = getState(userId);
    if (state?.state === 'add_merchant_photo') {
      const d = state.data || {};
      const userName = [query.from?.first_name, query.from?.last_name].filter(Boolean).join(' ') || query.from?.username || '';
      clearState(userId);
      const pid = addPendingMerchant({
        userId,
        userName,
        nickname: d.nickname || null,
        description: d.description || '',
        photoFileId: null,
      });
      await bot.sendMessage(
        chatId,
        '✅ Заявка на добавление информации о мерчанте отправлена. Ожидайте проверки.',
        mainMenu()
      );
      await notifyAdminNewMerchant(pid, { ...d, userId, userName }, null);
    }
    return;
  }

  if (data === 'add_photo_skip') {
    const state = getState(userId);
    if (state?.state === 'add_photo') {
      const d = state.data || {};
      clearState(userId);
      const pid = addPendingScammer({
        userId,
        userName: '',
        phone: d.phone || null,
        username: d.username || null,
        description: d.description || '',
        photoFileId: null,
      });
      await bot.sendMessage(chatId, 'Заявка отправлена. Ожидайте проверки.', mainMenu());
      await notifyAdminNewScammer(pid, { ...d, userId, userName: query.from?.first_name || '' }, null);
    }
    return;
  }

  if (data === 'subscription') {
    const subText =
      '💳 *Подписка*\n\n' +
      `Сеть: *BEP20 (BSC)*\nАдрес:\n\`${WALLET_BEP20}\`\n\n` +
      `• Неделя — *${PRICE_WEEK_USDT} USDT*\n` +
      `• Месяц — *${PRICE_MONTH_USDT} USDT*\n\n` +
      'После перевода отправьте команду /paid и укажите хэш транзакции или приложите скрин.';
    await bot.editMessageText(subText, {
      chat_id: chatId,
      message_id: query.message?.message_id,
      parse_mode: 'Markdown',
      ...subscriptionKeyboard(),
    }).catch(() => bot.sendMessage(chatId, subText, { parse_mode: 'Markdown', ...subscriptionKeyboard() }));
    return;
  }

  if (data === 'my_sub') {
    const active = hasActiveSubscription(userId);
    const { used, limit } = canMakeCheck(userId);
    let t = active
      ? '✅ У вас активна подписка. Проверки без ограничений.'
      : `📋 Бесплатно: ${used}/${limit} проверок в сутки. Оформите подписку для безлимита.`;
    await bot.editMessageText(t, {
      chat_id: chatId,
      message_id: query.message?.message_id,
      ...mainMenu(),
    }).catch(() => bot.sendMessage(chatId, t, mainMenu()));
    return;
  }
});

bot.on('message', async (msg) => {
  const text = (msg.text || '').trim();
  const userId = msg.from?.id;
  if (!isAdmin(userId)) return;

  if (text.startsWith('/approve_scammer ')) {
    const id = parseInt(text.replace(/^\/approve_scammer\s+/, ''), 10);
    const pending = getPendingScammer(id);
    if (!pending || pending.status !== 'pending') {
      await bot.sendMessage(msg.chat.id, 'Заявка не найдена или уже обработана.');
      return;
    }
    setPendingScammerStatus(id, 'approved');
    addScammerFromPending(pending);
    await bot.sendMessage(msg.chat.id, `Заявка #${id} одобрена, скамер добавлен в базу.`);
    try {
      await bot.sendMessage(pending.user_id, 'Ваша заявка на добавление скамера одобрена. Спасибо!');
    } catch (e) {}
    return;
  }

  if (text.startsWith('/reject_scammer ')) {
    const id = parseInt(text.replace(/^\/reject_scammer\s+/, ''), 10);
    const pending = getPendingScammer(id);
    if (!pending || pending.status !== 'pending') {
      await bot.sendMessage(msg.chat.id, 'Заявка не найдена или уже обработана.');
      return;
    }
    setPendingScammerStatus(id, 'rejected');
    await bot.sendMessage(msg.chat.id, `Заявка #${id} отклонена.`);
    try {
      await bot.sendMessage(pending.user_id, 'К сожалению, ваша заявка на добавление скамера отклонена.');
    } catch (e) {}
    return;
  }

  if (text.startsWith('/approve_payment ') || text.startsWith('/approvepayment ')) {
    const rest = text.replace(/^\/approve_payment\s+|^\/approvepayment\s+/, '').trim().split(/\s+/);
    const paymentId = parseInt(rest[0], 10);
    const period = (rest[1] || 'month').toLowerCase();
    if (!['week', 'month'].includes(period)) {
      await bot.sendMessage(msg.chat.id, 'Использование: /approve_payment <id> [week|month]');
      return;
    }
    console.log(`[approve_payment] Payment ID: ${paymentId}, period: ${period}, admin: ${userId}`);
    const payment = getPayment(paymentId);
    if (!payment) {
      console.log(`[approve_payment] Payment ${paymentId} not found`);
      await bot.sendMessage(msg.chat.id, `Платёж #${paymentId} не найден.`);
      return;
    }
    if (payment.status !== 'pending') {
      console.log(`[approve_payment] Payment ${paymentId} status is ${payment.status}, not pending`);
      await bot.sendMessage(msg.chat.id, `Платёж #${paymentId} уже обработан (статус: ${payment.status}).`);
      return;
    }
    console.log(`[approve_payment] Approving payment ${paymentId} for user ${payment.user_id}`);
    setPaymentStatus(paymentId, 'confirmed');
    const until = grantSubscription(payment.user_id, period);
    console.log(`[approve_payment] Subscription granted until ${until}`);
    await bot.sendMessage(msg.chat.id, `Платёж #${paymentId} подтверждён. Подписка до ${until}.`);
    try {
      await bot.sendMessage(
        payment.user_id,
        `✅ Оплата подтверждена. Подписка активна до ${until}. Проверки без ограничений.`
      );
    } catch (e) {
      console.error(`[approve_payment] Failed to notify user ${payment.user_id}:`, e.message);
    }
    return;
  }

  if (text.startsWith('/reject_payment ') || text.startsWith('/rejectpayment ')) {
    const paymentId = parseInt(text.replace(/^\/reject_payment\s+|^\/rejectpayment\s+/, ''), 10);
    const payment = getPayment(paymentId);
    if (!payment || payment.status !== 'pending') {
      await bot.sendMessage(msg.chat.id, 'Платёж не найден или уже обработан.');
      return;
    }
    setPaymentStatus(paymentId, 'rejected');
    await bot.sendMessage(msg.chat.id, `Платёж #${paymentId} отклонён.`);
    try {
      await bot.sendMessage(payment.user_id, 'К сожалению, платёж не подтверждён. Проверьте данные и попробуйте снова.');
    } catch (e) {}
    return;
  }

  if (text === '/add_scammer') {
    setState(userId, 'admin_add_phone', {});
    await bot.sendMessage(msg.chat.id, 'Введите номер и/или ник скамера (одним сообщением):');
    return;
  }

  if (text === '/add_merchant') {
    setState(userId, 'admin_add_merchant_nick', {});
    await bot.sendMessage(msg.chat.id, 'Введите ник или тег мерчанта:');
    return;
  }

  if (text.startsWith('/approve_merchant ')) {
    const id = parseInt(text.replace(/^\/approve_merchant\s+/, ''), 10);
    const pending = getPendingMerchant(id);
    if (!pending || pending.status !== 'pending') {
      await bot.sendMessage(msg.chat.id, 'Заявка не найдена или уже обработана.');
      return;
    }
    setPendingMerchantStatus(id, 'approved');
    addMerchantFromPending(pending);
    await bot.sendMessage(msg.chat.id, `Заявка #${id} одобрена, информация о мерчанте добавлена в базу.`);
    try {
      await bot.sendMessage(pending.user_id, 'Ваша заявка на добавление информации о мерчанте одобрена. Спасибо!');
    } catch (e) {}
    return;
  }

  if (text.startsWith('/reject_merchant ')) {
    const id = parseInt(text.replace(/^\/reject_merchant\s+/, ''), 10);
    const pending = getPendingMerchant(id);
    if (!pending || pending.status !== 'pending') {
      await bot.sendMessage(msg.chat.id, 'Заявка не найдена или уже обработана.');
      return;
    }
    setPendingMerchantStatus(id, 'rejected');
    await bot.sendMessage(msg.chat.id, `Заявка #${id} отклонена.`);
    try {
      await bot.sendMessage(pending.user_id, 'К сожалению, ваша заявка на добавление информации о мерчанте отклонена.');
    } catch (e) {}
    return;
  }

  if (text.startsWith('/add_top_merchant ')) {
    const merchantId = parseInt(text.replace(/^\/add_top_merchant\s+/, ''), 10);
    const merchant = getMerchant(merchantId);
    if (!merchant) {
      await bot.sendMessage(msg.chat.id, 'Мерчант с таким ID не найден.');
      return;
    }
    setMerchantTop(merchantId, 1);
    await bot.sendMessage(
      msg.chat.id,
      `Мерчант #${merchantId} (${(merchant.nickname || merchant.tag || '—').replace(/\*/g, '')}) добавлен в топ лучших.`
    );
    return;
  }

  if (text.startsWith('/remove_top_merchant ')) {
    const merchantId = parseInt(text.replace(/^\/remove_top_merchant\s+/, ''), 10);
    const merchant = getMerchant(merchantId);
    if (!merchant) {
      await bot.sendMessage(msg.chat.id, 'Мерчант с таким ID не найден.');
      return;
    }
    setMerchantTop(merchantId, 0);
    await bot.sendMessage(msg.chat.id, `Мерчант #${merchantId} убран из топа.`);
    return;
  }

  if (text === '/stats') {
    const db = require('./db').getDb();
    const scammers = db.prepare('SELECT COUNT(*) as c FROM scammers').get();
    const pendingS = db.prepare('SELECT COUNT(*) as c FROM pending_scammers WHERE status = ?').get('pending');
    const pendingP = db.prepare('SELECT COUNT(*) as c FROM payments WHERE status = ?').get('pending');
    const merchants = db.prepare('SELECT COUNT(*) as c FROM merchants').get();
    const pendingM = db.prepare('SELECT COUNT(*) as c FROM pending_merchants WHERE status = ?').get('pending');
    const topM = db.prepare('SELECT COUNT(*) as c FROM merchants WHERE is_top = 1').get();
    db.close();
    await bot.sendMessage(
      msg.chat.id,
      `📊 Скамеров: ${scammers.c} | Заявок скамеров: ${pendingS.c}\n` +
      `Ожидают оплаты: ${pendingP.c}\n` +
      `Мерчантов: ${merchants.c} | В топе: ${topM.c} | Заявок мерчантов: ${pendingM.c}`
    );
    return;
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  const state = getState(userId);
  if (!isAdmin(userId) || state?.state !== 'admin_add_phone') return;

  const text = (msg.text || '').trim();
  const hasDigit = /\d/.test(text);
  const hasLetter = /[a-zA-Zа-яА-Я_]/.test(text);
  if (!text || (!hasDigit && !hasLetter)) {
    await bot.sendMessage(msg.chat.id, 'Введите номер и/или ник.');
    return;
  }
  setState(userId, 'admin_add_desc', {
    phone: hasDigit ? text : null,
    username: hasLetter ? text : null,
  });
  await bot.sendMessage(msg.chat.id, 'Введите описание скамера:');
});

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  const state = getState(userId);
  if (!isAdmin(userId) || state?.state !== 'admin_add_desc') return;

  const text = (msg.text || '').trim();
  const data = state.data || {};
  clearState(userId);
  addScammerManual(data.phone, data.username, text, null);
  await bot.sendMessage(msg.chat.id, 'Скамер добавлен в базу вручную.');
});

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  const state = getState(userId);
  if (!isAdmin(userId) || state?.state !== 'admin_add_merchant_nick') return;

  const text = (msg.text || '').trim().replace(/^@/, '');
  if (!text || text.length < 2) {
    await bot.sendMessage(msg.chat.id, 'Введите ник/тег (от 2 символов).');
    return;
  }
  setState(userId, 'admin_add_merchant_desc', { nickname: text });
  await bot.sendMessage(msg.chat.id, 'Введите описание мерчанта:');
});

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  const state = getState(userId);
  if (!isAdmin(userId) || state?.state !== 'admin_add_merchant_desc') return;

  const text = (msg.text || '').trim();
  const data = state.data || {};
  clearState(userId);
  const id = addMerchantManual(data.nickname, null, text, null, 0);
  await bot.sendMessage(
    msg.chat.id,
    `Мерчант добавлен в базу (ID: ${id}). В топ: /add_top_merchant ${id}`
  );
});

bot.on('photo', async (msg) => {
  const userId = msg.from?.id;
  const caption = (msg.caption || '').trim();
  if (!caption.toLowerCase().startsWith('/paid')) return;
  ensureUser(userId);
  const txHash = caption.replace(/^\/paid\s*/i, '').trim() || null;
  const paymentId = addPayment({ userId, amountUsdt: null, period: 'manual', txHash });
  await notifyAdminNewPayment(paymentId, userId, msg, txHash);
  await bot.sendMessage(msg.chat.id, 'Заявка на оплату отправлена. Ожидайте подтверждения.', mainMenu());
});

function init() {
  const db = require('./db');
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db.initDb();
  console.log('DB initialized');
}

init();
console.log('Bot CoinEX_SkamerList running...');
