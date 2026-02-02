const config = require('./config/env');
const bot = require('./bot');
const { Markup } = require('telegraf');
const GoogleSheetsService = require('./services/googleSheetsService');
const IikoService = require('./services/iikoService');

console.log('Starting iiko Writeoff Bot...');
console.log(`Environment: ${config.nodeEnv}`);

// ==================== ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ====================
const sheetsService = new GoogleSheetsService(
  config.googleServiceAccount,
  config.googleSheetId
);
console.log('Google Sheets service initialized');

// iiko Server API (REST API v2)
const iikoService = new IikoService({
  baseUrl: config.iiko.baseUrl,
  login: config.iiko.login,
  password: config.iiko.password
});
console.log('iiko Server API service initialized');
console.log(`iiko URL: ${config.iiko.baseUrl}`);

// ==================== КЭШИ СПРАВОЧНИКОВ iiko ====================
// Загружаются при старте и по запросу
let STORES = [];           // Список складов
let EXPENSE_ACCOUNTS = []; // Расходные счета
let PRODUCTS = [];         // Номенклатура (кэш)

/**
 * Загрузить справочники из iiko
 */
async function loadIikoReferences() {
  console.log('Loading iiko references...');
  let success = true;

  // Загружаем склады
  try {
    const stores = await iikoService.getStores();
    STORES = stores.map(s => ({
      id: s.id,
      name: s.name || s.code || 'Без названия'
    }));
    console.log(`Loaded ${STORES.length} stores`);
  } catch (error) {
    console.error('Error loading stores:', error.message);
    success = false;
  }

  // Загружаем расходные счета (опционально)
  try {
    const accounts = await iikoService.getExpenseAccounts();
    EXPENSE_ACCOUNTS = accounts.map(a => ({
      id: a.id,
      name: a.name || a.code || 'Без названия'
    }));
    console.log(`Loaded ${EXPENSE_ACCOUNTS.length} expense accounts`);
  } catch (error) {
    console.warn('Warning: Could not load expense accounts:', error.message);
    // Продолжаем работу без счетов
  }

  // Загружаем номенклатуру для сопоставления товаров
  try {
    const products = await iikoService.getProducts();
    PRODUCTS = products.map(p => ({
      id: p.id,
      name: p.name || '',
      code: p.code || '',
      num: p.num || ''
    }));
    console.log(`Loaded ${PRODUCTS.length} products`);
  } catch (error) {
    console.warn('Warning: Could not load products:', error.message);
    // Продолжаем работу без номенклатуры
  }

  return success && STORES.length > 0;
}

// Хранилище состояний пользователей (в памяти)
const userStates = new Map();

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

/**
 * Получить состояние пользователя
 */
function getUserState(userId) {
  return userStates.get(userId) || { step: null };
}

/**
 * Установить состояние пользователя
 */
function setUserState(userId, state) {
  userStates.set(userId, { ...getUserState(userId), ...state });
}

/**
 * Очистить состояние пользователя
 */
function clearUserState(userId) {
  userStates.delete(userId);
}

/**
 * Форматировать список позиций для отображения
 */
function formatItems(items, showMatched = false) {
  return items.map((item, i) => {
    if (item.parseError) {
      return `${i + 1}. ${item.name} (не распознано)`;
    }
    let line = `${i + 1}. ${item.name} - ${item.amount} ${item.unit}`;
    if (showMatched) {
      if (item.productId) {
        line += ` ✓`;
      } else {
        line += ` (не найден в iiko)`;
      }
    }
    return line;
  }).join('\n');
}

/**
 * Сопоставить названия товаров с номенклатурой iiko
 * Возвращает items с заполненными productId
 */
function matchItemsToProducts(items) {
  return items.map(item => {
    if (item.parseError) return item;

    const searchName = item.name.toLowerCase().trim();

    // Ищем точное совпадение
    let product = PRODUCTS.find(p =>
      p.name.toLowerCase() === searchName
    );

    // Если не найдено - ищем частичное совпадение
    if (!product) {
      product = PRODUCTS.find(p =>
        p.name.toLowerCase().includes(searchName) ||
        searchName.includes(p.name.toLowerCase())
      );
    }

    // Если не найдено - ищем по коду
    if (!product) {
      product = PRODUCTS.find(p =>
        p.code?.toLowerCase() === searchName ||
        p.num?.toLowerCase() === searchName
      );
    }

    return {
      ...item,
      productId: product?.id || null,
      matchedName: product?.name || null
    };
  });
}

// ==================== КОМАНДА /start ====================
bot.command('start', async (ctx) => {
  clearUserState(ctx.from.id);

  await ctx.reply(
    'Привет! Я бот для списания товаров в iiko.\n\n' +
    'Используй кнопку ниже, чтобы создать акт списания.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Списать в iiko', 'start_writeoff')],
      [Markup.button.callback('История списаний', 'history')]
    ])
  );
});

// ==================== КОМАНДА /writeoff ====================
bot.command('writeoff', async (ctx) => {
  clearUserState(ctx.from.id);

  // Проверяем загружены ли справочники
  if (STORES.length === 0) {
    await ctx.reply('Загружаю данные из iiko...');
    await loadIikoReferences();
  }

  if (STORES.length === 0) {
    return ctx.reply(
      'Не удалось загрузить склады из iiko.\n' +
      'Проверь подключение и попробуй /writeoff ещё раз.'
    );
  }

  // Показываем выбор склада
  const storeButtons = STORES.slice(0, 10).map(store =>
    [Markup.button.callback(store.name.substring(0, 30), `select_store:${store.id}`)]
  );
  storeButtons.push([Markup.button.callback('Отмена', 'cancel')]);

  await ctx.reply(
    'Выбери склад (откуда списываем):',
    Markup.inlineKeyboard(storeButtons)
  );
});

// ==================== КОМАНДА /refresh ====================
bot.command('refresh', async (ctx) => {
  await ctx.reply('Обновляю справочники из iiko...');

  const success = await loadIikoReferences();

  if (success) {
    await ctx.reply(
      `Справочники обновлены:\n` +
      `- Складов: ${STORES.length}\n` +
      `- Расходных счетов: ${EXPENSE_ACCOUNTS.length}\n` +
      `- Товаров: ${PRODUCTS.length}`
    );
  } else {
    await ctx.reply('Ошибка обновления справочников. Проверь подключение к iiko.');
  }
});

// ==================== CALLBACK: Начать списание ====================
bot.action('start_writeoff', async (ctx) => {
  await ctx.answerCbQuery();
  clearUserState(ctx.from.id);

  // Проверяем загружены ли справочники
  if (STORES.length === 0) {
    await ctx.editMessageText('Загружаю данные из iiko...');
    await loadIikoReferences();
  }

  if (STORES.length === 0) {
    return ctx.editMessageText(
      'Не удалось загрузить склады из iiko.\n' +
      'Проверь подключение и попробуй ещё раз.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Попробовать снова', 'start_writeoff')]
      ])
    );
  }

  const storeButtons = STORES.slice(0, 10).map(store =>
    [Markup.button.callback(store.name.substring(0, 30), `select_store:${store.id}`)]
  );
  storeButtons.push([Markup.button.callback('Отмена', 'cancel')]);

  await ctx.editMessageText(
    'Выбери склад (откуда списываем):',
    Markup.inlineKeyboard(storeButtons)
  );
});

// ==================== CALLBACK: Выбор склада ====================
bot.action(/^select_store:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const storeId = ctx.match[1];
  const store = STORES.find(s => s.id === storeId);

  if (!store) {
    return ctx.editMessageText('Склад не найден. Попробуй /start');
  }

  // Сохраняем выбранный склад
  setUserState(ctx.from.id, {
    step: 'select_account',
    storeId: store.id,
    storeName: store.name
  });

  // Показываем выбор расходного счета
  if (EXPENSE_ACCOUNTS.length === 0) {
    // Если счетов нет, пропускаем этот шаг и используем дефолтный
    setUserState(ctx.from.id, {
      step: 'waiting_items',
      storeId: store.id,
      storeName: store.name,
      accountId: null,
      accountName: 'Не указан'
    });

    return ctx.editMessageText(
      `Склад: ${store.name}\n\n` +
      'Теперь отправь список позиций для списания.\n\n' +
      'Формат:\n' +
      '`помидор 5 кг; огурец 3 кг; курица филе 10 кг`\n\n' +
      'Или каждую позицию с новой строки:\n' +
      '`помидор 5 кг\n' +
      'огурец 3 кг\n' +
      'курица филе 10 кг`',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Отмена', 'cancel')]
        ])
      }
    );
  }

  const accountButtons = EXPENSE_ACCOUNTS.slice(0, 10).map(acc =>
    [Markup.button.callback(acc.name.substring(0, 30), `select_account:${acc.id}`)]
  );
  accountButtons.push([Markup.button.callback('Назад', 'start_writeoff')]);
  accountButtons.push([Markup.button.callback('Отмена', 'cancel')]);

  await ctx.editMessageText(
    `Склад: ${store.name}\n\n` +
    'Выбери расходный счёт (причина списания):',
    Markup.inlineKeyboard(accountButtons)
  );
});

// ==================== CALLBACK: Выбор расходного счёта ====================
bot.action(/^select_account:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const accountId = ctx.match[1];
  const account = EXPENSE_ACCOUNTS.find(a => a.id === accountId);
  const state = getUserState(ctx.from.id);

  if (!account || !state.storeId) {
    return ctx.editMessageText('Ошибка. Попробуй /writeoff заново.');
  }

  // Сохраняем выбранный счёт
  setUserState(ctx.from.id, {
    ...state,
    step: 'waiting_items',
    accountId: account.id,
    accountName: account.name
  });

  await ctx.editMessageText(
    `Склад: ${state.storeName}\n` +
    `Счёт: ${account.name}\n\n` +
    'Теперь отправь список позиций для списания.\n\n' +
    'Формат:\n' +
    '`помидор 5 кг; огурец 3 кг; курица филе 10 кг`\n\n' +
    'Или каждую позицию с новой строки:\n' +
    '`помидор 5 кг\n' +
    'огурец 3 кг\n' +
    'курица филе 10 кг`',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

// ==================== ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ ====================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);

  // Если пользователь не в процессе списания
  if (state.step !== 'waiting_items') {
    return ctx.reply(
      'Используй /start или /writeoff чтобы начать списание.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Списать в iiko', 'start_writeoff')]
      ])
    );
  }

  const rawMessage = ctx.message.text;

  // Парсим позиции
  let parsedItems = iikoService.parseWriteoffItems(rawMessage);

  if (parsedItems.length === 0) {
    return ctx.reply(
      'Не удалось распознать позиции.\n\n' +
      'Используй формат: `название количество единица`\n' +
      'Например: `помидор 5 кг; огурец 3 кг`',
      { parse_mode: 'Markdown' }
    );
  }

  // Сопоставляем с номенклатурой iiko
  if (PRODUCTS.length > 0) {
    parsedItems = matchItemsToProducts(parsedItems);
  }

  // Проверяем на ошибки парсинга
  const errorItems = parsedItems.filter(item => item.parseError);
  const unmatchedItems = parsedItems.filter(item => !item.parseError && !item.productId);
  let warningText = '';

  if (errorItems.length > 0) {
    warningText += '\n\nНе удалось распознать:\n' +
      errorItems.map(item => `- ${item.name}`).join('\n');
  }

  if (unmatchedItems.length > 0 && PRODUCTS.length > 0) {
    warningText += '\n\nНе найдены в номенклатуре iiko:\n' +
      unmatchedItems.map(item => `- ${item.name}`).join('\n');
  }

  // Сохраняем распарсенные данные
  setUserState(userId, {
    ...state,
    step: 'confirm',
    rawMessage,
    parsedItems
  });

  // Показываем подтверждение
  const accountInfo = state.accountName ? `\nСчёт: ${state.accountName}` : '';
  const hasUnmatched = unmatchedItems.length > 0 && PRODUCTS.length > 0;

  await ctx.reply(
    `Склад: ${state.storeName}${accountInfo}\n\n` +
    `Позиции для списания:\n${formatItems(parsedItems, PRODUCTS.length > 0)}` +
    warningText +
    (hasUnmatched ? '\n\n⚠️ Товары без ID не будут списаны в iiko!' : '') +
    '\n\nПодтвердить списание?',
    Markup.inlineKeyboard([
      [Markup.button.callback('Подтвердить', 'confirm_writeoff')],
      [Markup.button.callback('Изменить', 'edit_items')],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== CALLBACK: Подтверждение списания ====================
bot.action('confirm_writeoff', async (ctx) => {
  await ctx.answerCbQuery('Создаю акт списания...');

  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (state.step !== 'confirm' || !state.parsedItems) {
    return ctx.editMessageText('Ошибка состояния. Начни заново с /writeoff');
  }

  try {
    // 1. Логируем в Google Sheets
    const rowIndex = await sheetsService.appendWriteoffRow({
      storeId: state.storeId,
      storeName: state.storeName,
      accountId: state.accountId,
      accountName: state.accountName,
      rawMessage: state.rawMessage,
      parsedItems: state.parsedItems,
      telegramId: userId
    });

    // 2. Отправляем в iiko Server API
    // Берем только товары с productId (успешно сопоставленные)
    const validItems = state.parsedItems.filter(item => !item.parseError && item.productId);

    // Проверяем наличие accountId
    if (!state.accountId) {
      throw new Error('Не выбран расходный счёт. Начните заново.');
    }

    // Если нет ни одного сопоставленного товара
    if (validItems.length === 0) {
      await sheetsService.updateWriteoffRow(rowIndex, {
        status: 'IIKO_ERROR',
        errorMessage: 'Ни один товар не найден в номенклатуре iiko'
      });

      return ctx.editMessageText(
        'Ни один товар не найден в номенклатуре iiko.\n\n' +
        'Проверь названия товаров и попробуй снова.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Изменить', 'edit_items')],
          [Markup.button.callback('В меню', 'back_to_menu')]
        ])
      );
    }

    const iikoResult = await iikoService.createWriteoffDocument({
      storeId: state.storeId,
      accountId: state.accountId,
      items: validItems,
      comment: `Списание через Telegram. User: ${ctx.from.username || userId}`
    });

    // 3. Обновляем статус в Google Sheets
    if (iikoResult.success) {
      await sheetsService.updateWriteoffRow(rowIndex, {
        iikoDocumentId: iikoResult.documentId,
        iikoDocumentNumber: iikoResult.documentNumber,
        status: 'IIKO_OK'
      });

      const skippedItems = state.parsedItems.filter(item => !item.parseError && !item.productId);
      let successMessage = `Акт списания создан!\n\n` +
        `Склад: ${state.storeName}\n` +
        `Счёт: ${state.accountName || '-'}\n` +
        `Документ: ${iikoResult.documentNumber || iikoResult.documentId}\n\n` +
        `Списано (${validItems.length}):\n${formatItems(validItems)}`;

      if (skippedItems.length > 0) {
        successMessage += `\n\nПропущено (не найдены в iiko):\n` +
          skippedItems.map(item => `- ${item.name}`).join('\n');
      }

      await ctx.editMessageText(successMessage, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Новое списание', 'start_writeoff')],
          [Markup.button.callback('В меню', 'back_to_menu')]
        ])
      });

    } else {
      // Ошибка iiko
      const errorMsg = iikoResult.errors?.join(', ') || iikoResult.error || 'Неизвестная ошибка';

      await sheetsService.updateWriteoffRow(rowIndex, {
        status: 'IIKO_ERROR',
        errorMessage: errorMsg
      });

      await ctx.editMessageText(
        `Ошибка создания акта в iiko!\n\n` +
        `Ошибка: ${errorMsg}\n\n` +
        `Данные сохранены в журнал.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Попробовать снова', 'retry_writeoff')],
          [Markup.button.callback('В меню', 'back_to_menu')]
        ])
      );
    }

    clearUserState(userId);

  } catch (error) {
    console.error('Error in confirm_writeoff:', error);

    await ctx.editMessageText(
      `Произошла ошибка: ${error.message}\n\nПопробуй ещё раз.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Начать заново', 'start_writeoff')]
      ])
    );

    clearUserState(userId);
  }
});

// ==================== CALLBACK: Изменить позиции ====================
bot.action('edit_items', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (!state.storeName) {
    return ctx.editMessageText('Ошибка. Начни заново с /writeoff');
  }

  setUserState(userId, {
    ...state,
    step: 'waiting_items',
    rawMessage: null,
    parsedItems: null
  });

  await ctx.editMessageText(
    `Склад: ${state.storeName}\n\n` +
    'Отправь новый список позиций для списания.\n\n' +
    'Формат: `помидор 5 кг; огурец 3 кг`',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

// ==================== CALLBACK: История списаний ====================
bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    const writeoffs = await sheetsService.getRecentWriteoffs(ctx.from.id, 5);

    if (writeoffs.length === 0) {
      return ctx.editMessageText(
        'У тебя пока нет списаний.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Создать списание', 'start_writeoff')],
          [Markup.button.callback('В меню', 'back_to_menu')]
        ])
      );
    }

    let historyText = 'Последние списания:\n\n';

    for (const w of writeoffs) {
      const statusEmoji = w.status === 'IIKO_OK' ? '✅' : w.status === 'IIKO_ERROR' ? '❌' : '⏳';
      historyText += `${statusEmoji} ${w.timestamp}\n`;
      historyText += `Склад: ${w.storeName}\n`;
      if (w.accountName) {
        historyText += `Счёт: ${w.accountName}\n`;
      }
      historyText += `${w.rawMessage?.substring(0, 50) || ''}${(w.rawMessage?.length || 0) > 50 ? '...' : ''}\n`;
      if (w.iikoDocNumber || w.iikoDocumentId) {
        historyText += `Doc: ${w.iikoDocNumber || w.iikoDocumentId}\n`;
      }
      historyText += '\n';
    }

    await ctx.editMessageText(
      historyText,
      Markup.inlineKeyboard([
        [Markup.button.callback('Новое списание', 'start_writeoff')],
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );

  } catch (error) {
    console.error('Error getting history:', error);
    ctx.editMessageText('Ошибка загрузки истории.');
  }
});

// ==================== CALLBACK: Отмена ====================
bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery('Отменено');
  clearUserState(ctx.from.id);

  await ctx.editMessageText(
    'Действие отменено.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Списать в iiko', 'start_writeoff')],
      [Markup.button.callback('В меню', 'back_to_menu')]
    ])
  );
});

// ==================== CALLBACK: Назад в меню ====================
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  clearUserState(ctx.from.id);

  await ctx.editMessageText(
    'Главное меню.\n\nВыбери действие:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Списать в iiko', 'start_writeoff')],
      [Markup.button.callback('История списаний', 'history')]
    ])
  );
});

// ==================== КОМАНДА /help ====================
bot.command('help', (ctx) => {
  ctx.reply(
    'Справка по боту списаний:\n\n' +
    '/start - Главное меню\n' +
    '/writeoff - Создать акт списания\n' +
    '/help - Эта справка\n\n' +
    'Как использовать:\n' +
    '1. Нажми "Списать в iiko"\n' +
    '2. Выбери склад\n' +
    '3. Отправь список позиций в формате:\n' +
    '   помидор 5 кг; огурец 3 кг\n' +
    '4. Подтверди списание\n\n' +
    'Данные сохраняются в журнал Google Sheets.'
  );
});

// ==================== GRACEFUL SHUTDOWN ====================
process.once('SIGINT', () => {
  console.log('Received SIGINT, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop('SIGTERM');
});

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    // Инициализируем лист Google Sheets
    await sheetsService.ensureSheetExists();
    console.log('Google Sheets ready');

    // Загружаем справочники из iiko
    console.log('Connecting to iiko Server API...');
    const iikoLoaded = await loadIikoReferences();

    if (iikoLoaded) {
      console.log('iiko references loaded successfully');
      console.log(`  Stores: ${STORES.length}`);
      console.log(`  Expense accounts: ${EXPENSE_ACCOUNTS.length}`);
      console.log(`  Products: ${PRODUCTS.length}`);
    } else {
      console.warn('Warning: Could not load iiko references. Will retry on first request.');
    }

    // Запускаем бота
    bot.launch().then(() => {
      console.log('Bot polling started');
    });

    // Даём время на подключение
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('Bot started successfully!');
    console.log(`Bot username: @shrmtransferbot`);
    console.log('Send /start to the bot in Telegram to test');

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

start();
