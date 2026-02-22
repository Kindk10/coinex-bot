# CoinEX_SkamerList — Telegram-бот

Бот для проверки контактов по списку скамеров, приёма заявок на добавление новых скамеров и подписки (BEP20 USDT).

## Возможности

- **Проверка скамера** — по номеру телефона или нику (1 проверка в сутки бесплатно, безлимит по подписке).
- **Добавить скамера** — заявка с номером/ником, описанием и опционально фото. Заявки приходят админам на одобрение/отклонение.
- **Проверить мерчанта** — по нику или тегу: описание о честности работы мерчанта из базы (база заполняется вручную и из заявок).
- **Добавить информацию о мерчанте** — заявка: ник, описание, опционально фото; админ одобряет или отклоняет.
- **Топ лучших мерчантов** — список мерчантов, которых админы добавили в топ.
- **Подписка** — оплата USDT (BEP20): неделя 5 USDT, месяц 15 USDT. После перевода пользователь отправляет хэш или скрин, вы проверяете и выдаёте доступ командами.

## Установка

1. Создайте бота в Telegram через [@BotFather](https://t.me/BotFather), задайте имя **CoinEX_SkamerList**, скопируйте токен.
2. Узнайте свой Telegram User ID (например, через [@userinfobot](https://t.me/userinfobot)) — он нужен как `ADMIN_ID`.
3. В папке бота выполните:

```bash
cd coin-ex-bot
npm install
```

4. Создайте файл `.env` (скопируйте из примера):

```bash
copy .env.example .env
```

5. В `.env` укажите:

- `BOT_TOKEN` — токен от BotFather  
- `ADMIN_ID` — один или несколько Telegram User ID через запятую (например `8290475728,6721010507`)  

6. Запуск:

```bash
npm start
```

При первом запуске создаётся папка `data` и файл БД `data/bot.db`.

## Запуск на Linux-сервере (постоянно)

Чтобы бот работал 24/7 на арендованном VPS/сервере и перезапускался при сбоях:

### 1. Подключитесь к серверу по SSH

```bash
ssh user@ваш-сервер-ip
```

### 2. Установите Node.js (если ещё не установлен)

На Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Проверка: `node -v` (должна быть версия 18 или 20).

### 3. Загрузите проект на сервер

Варианты:

- **Через Git** (если проект в репозитории):
  ```bash
  sudo mkdir -p /opt/coinex-bot && sudo chown $USER:$USER /opt/coinex-bot
  git clone https://github.com/ваш-репо/coin-ex-bot.git /opt/coinex-bot
  ```

- **Через SCP с вашего ПК** (из папки, где лежит `coin-ex-bot`):
  ```bash
  scp -r coin-ex-bot user@ваш-сервер-ip:/opt/coinex-bot
  ```

Замените путь `/opt/coinex-bot` на свой (например `/home/username/coin-ex-bot`), если нужно.

### 4. Установка и настройка на сервере

```bash
cd /opt/coinex-bot
npm install
cp .env.example .env
nano .env   # впишите BOT_TOKEN и ADMIN_ID
```

Сохраните `.env` (в nano: Ctrl+O, Enter, Ctrl+X).

### 5. Запуск как сервис systemd (автозапуск при перезагрузке)

Скопируйте unit-файл и при необходимости отредактируйте путь и пользователя:

```bash
sudo cp deploy/coinex-bot.service /etc/systemd/system/
sudo nano /etc/systemd/system/coinex-bot.service
```

В файле проверьте:
- `WorkingDirectory=/opt/coinex-bot` — должен совпадать с путём, куда вы положили бота;
- `User=root` — можно заменить на своего пользователя, например `User=ubuntu`;
- `ExecStart=/usr/bin/node index.js` — если `node` установлен в другое место, укажите полный путь (`which node`).

Включите и запустите сервис:

```bash
sudo systemctl daemon-reload
sudo systemctl enable coinex-bot
sudo systemctl start coinex-bot
```

Проверка статуса и логов:

```bash
sudo systemctl status coinex-bot
sudo journalctl -u coinex-bot -f
```

Перезапуск после обновления кода:

```bash
sudo systemctl restart coinex-bot
```

Остановка:

```bash
sudo systemctl stop coinex-bot
```

База данных и папка `data/` создаются при первом запуске в каталоге бота; при перезапуске сервиса данные сохраняются.

## Импорт скамеров из экспорта Telegram

Если у вас есть экспорт чата со скамерами (HTML файл из Telegram Desktop):

```bash
npm run import-scammers "путь\к\messages.html"
```

Например:
```bash
npm run import-scammers "c:\Users\dkk150607\Downloads\Telegram Desktop\ChatExport_2026-02-22\messages.html"
```

Скрипт автоматически:
- Найдёт все сообщения в топике "Скамеры" (ответы на сообщение #157)
- Извлечёт номера телефонов, никнеймы и описания
- Добавит их в базу данных

## Заполнение баз вручную

Команды для админа:
- `/add_scammer` — бот попросит номер/ник, затем описание и добавит скамера в базу.
- `/add_merchant` — бот попросит ник/тег мерчанта и описание, добавит запись в базу мерчантов. Затем можно добавить в топ: `/add_top_merchant <id>`.

## Админ-команды (только для пользователей с `ADMIN_ID`)

| Команда | Описание |
|--------|----------|
| `/approve_scammer <id>` | Одобрить заявку на добавление скамера |
| `/reject_scammer <id>` | Отклонить заявку скамера |
| `/approve_merchant <id>` | Одобрить заявку на добавление информации о мерчанте |
| `/reject_merchant <id>` | Отклонить заявку мерчанта |
| `/approve_payment <id> [week\|month]` | Подтвердить оплату и выдать подписку (по умолчанию month) |
| `/reject_payment <id>` | Отклонить платёж |
| `/add_scammer` | Добавить скамера вручную |
| `/add_merchant` | Добавить мерчанта вручную (ник → описание) |
| `/add_top_merchant <id>` | Добавить мерчанта в топ лучших (id — из таблицы merchants) |
| `/remove_top_merchant <id>` | Убрать мерчанта из топа |
| `/stats` | Статистика: скамеры, заявки, платежи, мерчанты, топ |

## Оплата (BEP20)

- Сеть: **BEP20 (BSC)**  
- Адрес: `0x37c62127256469c559d07c0d314463e28c2aef69`  
- Неделя: 5 USDT, месяц: 15 USDT  

Пользователь переводит USDT и отправляет боту `/paid` и хэш транзакции (или скрин с подписью `/paid`). Вам приходит уведомление; после проверки перевода вы вводите `/approve_payment <id> week` или `/approve_payment <id> month`.

## Структура проекта

- `index.js` — логика бота (команды, кнопки, заявки, админка)
- `db.js` — инициализация SQLite
- `db-helpers.js` — работа с БД (скамеры, пользователи, подписки, заявки, платежи)
- `scripts/import-scammers.js` — импорт скамеров из HTML экспорта Telegram
- `deploy/coinex-bot.service` — unit systemd для запуска на Linux
- `data/bot.db` — база (создаётся при первом запуске)
- `.env` — токен и ADMIN_ID (не коммитить, создаётся на сервере вручную)

Удачи с запуском.
