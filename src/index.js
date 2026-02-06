const config = require('./config/env');
const bot = require('./bot');
const { Markup } = require('telegraf');
const cron = require('node-cron');
const GoogleSheetsService = require('./services/googleSheetsService');
const IikoService = require('./services/iikoService');

// ID группы для уведомлений о перемещениях
const TRANSFER_GROUP_ID = config.transferGroupId || -5237107467;

// UUID складов для перемещений
const KITCHEN_STORE_ID = config.kitchenStoreId;
const WAREHOUSE_STORE_ID = config.warehouseStoreId;

console.log('Starting Transfer Bot...');
console.log(`Environment: ${config.nodeEnv}`);

// ==================== ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ====================
const sheetsService = new GoogleSheetsService(
  config.googleServiceAccount,
  config.googleSheetId
);
console.log('Google Sheets service initialized');

const iikoService = new IikoService({
  baseUrl: config.iiko.baseUrl,
  login: config.iiko.login,
  password: config.iiko.password
});
console.log('iiko Server API service initialized');
console.log(`iiko URL: ${config.iiko.baseUrl}`);

// ==================== КЭШ НОМЕНКЛАТУРЫ ====================
let PRODUCTS = [];

/**
 * Загрузить номенклатуру из iiko
 */
async function loadProducts() {
  console.log('Loading products from iiko...');
  try {
    const products = await iikoService.getProducts();
    PRODUCTS = products.map(p => ({
      id: p.id,
      name: p.name || '',
      code: p.code || '',
      num: p.num || '',
      mainUnit: p.mainUnit || 'кг'
    }));
    console.log(`Loaded ${PRODUCTS.length} products`);
    return true;
  } catch (error) {
    console.warn('Warning: Could not load products:', error.message);
    return false;
  }
}

// Хранилище состояний пользователей
const userStates = new Map();

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function getUserState(userId) {
  return userStates.get(userId) || { step: null };
}

function setUserState(userId, state) {
  userStates.set(userId, { ...getUserState(userId), ...state });
}

function clearUserState(userId) {
  userStates.delete(userId);
}

/**
 * Форматировать список позиций
 */
function formatItemsList(items) {
  return items.map((item, i) =>
    `${i + 1}. ${item.name} - ${item.amount} ${item.unit}`
  ).join('\n');
}

/**
 * Форматировать сообщение для группы
 */
function formatGroupMessage(role, items, username) {
  const roleLabel = role === 'kitchen' ? 'Кухня' : 'Склад';
  const direction = role === 'kitchen'
    ? 'Кухня запрашивает товары'
    : 'Перемещение: Кухня -> Склад';

  let message = `📦 ${direction}\n`;
  message += `👤 ${username}\n\n`;
  message += items.map((item, i) =>
    `${i + 1}. ${item.name} — ${item.amount} ${item.unit}`
  ).join('\n');

  return message;
}

// ==================== КОМАНДА /start ====================
bot.command('start', async (ctx) => {
  clearUserState(ctx.from.id);

  await ctx.reply(
    'Привет! Я бот для перемещения товаров.\n\n' +
    'Выбери свою роль:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Кухня', 'role_kitchen')],
      [Markup.button.callback('Склад', 'role_warehouse')],
      [Markup.button.callback('История перемещений', 'history')]
    ])
  );
});

// ==================== КОМАНДА /help ====================
bot.command('help', (ctx) => {
  ctx.reply(
    'Справка по боту перемещений:\n\n' +
    '/start - Главное меню\n' +
    '/refresh - Обновить номенклатуру из iiko\n' +
    '/report - Отправить отчёт за день\n' +
    '/help - Эта справка\n\n' +
    'Как использовать:\n' +
    '1. Нажми /start и выбери роль (Кухня или Склад)\n' +
    '2. Введи название товара для поиска\n' +
    '3. Выбери товар из списка\n' +
    '4. Введи количество (например: 5 или 5 кг)\n' +
    '5. Добавь ещё товары или нажми "Переместить"\n' +
    '6. Подтверди перемещение\n\n' +
    'Кухня: список отправляется в Telegram-группу\n' +
    'Склад: создаётся документ перемещения в iiko + сообщение в группу'
  );
});

// ==================== КОМАНДА /refresh ====================
bot.command('refresh', async (ctx) => {
  await ctx.reply('Обновляю номенклатуру из iiko...');

  const success = await loadProducts();

  if (success) {
    await ctx.reply(`Номенклатура обновлена: ${PRODUCTS.length} товаров`);
  } else {
    await ctx.reply('Ошибка обновления номенклатуры. Проверь подключение к iiko.');
  }
});

// ==================== КОМАНДА /report ====================
bot.command('report', async (ctx) => {
  try {
    await ctx.reply('Формирую отчёт...');
    await sendDailyReport();
    await ctx.reply('Отчёт отправлен в группу.');
  } catch (error) {
    console.error('Error in /report command:', error.message);
    await ctx.reply(`Ошибка при формировании отчёта: ${error.message}`);
  }
});

// ==================== CALLBACK: Выбор роли ====================
bot.action('role_kitchen', async (ctx) => {
  await ctx.answerCbQuery();
  await startTransferFlow(ctx, 'kitchen');
});

bot.action('role_warehouse', async (ctx) => {
  await ctx.answerCbQuery();
  await startTransferFlow(ctx, 'warehouse');
});

/**
 * Начать флоу перемещения для выбранной роли
 */
async function startTransferFlow(ctx, role) {
  const userId = ctx.from.id;

  // Проверяем загружены ли товары
  if (PRODUCTS.length === 0) {
    await ctx.editMessageText('Загружаю номенклатуру из iiko...');
    await loadProducts();
  }

  if (PRODUCTS.length === 0) {
    return ctx.editMessageText(
      'Не удалось загрузить номенклатуру из iiko.\nПопробуй позже или нажми /refresh.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Попробовать снова', role === 'kitchen' ? 'role_kitchen' : 'role_warehouse')],
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );
  }

  const roleLabel = role === 'kitchen' ? 'Кухня' : 'Склад';

  setUserState(userId, {
    step: 'search_product',
    role,
    items: []
  });

  await ctx.editMessageText(
    `Роль: ${roleLabel}\n` +
    `Добавлено позиций: 0\n\n` +
    `Введи название товара для поиска:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
}

// ==================== ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ ====================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) {
    return;
  }

  // ===== ПОИСК ТОВАРА =====
  if (state.step === 'search_product') {
    if (PRODUCTS.length === 0) {
      return ctx.reply(
        'Номенклатура не загружена.\nИспользуй /refresh для обновления.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Отмена', 'cancel')]
        ])
      );
    }

    if (text.length < 2) {
      return ctx.reply('Введи минимум 2 символа для поиска');
    }

    const searchLower = text.toLowerCase();
    const matches = PRODUCTS.filter(p =>
      p.name && p.name.toLowerCase().includes(searchLower)
    ).slice(0, 8);

    if (matches.length === 0) {
      return ctx.reply(
        `Товар "${text}" не найден.\n\nПопробуй другое название:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Отмена', 'cancel')]
        ])
      );
    }

    const buttons = matches.map(p =>
      [Markup.button.callback(
        p.name.substring(0, 35) + (p.name.length > 35 ? '...' : ''),
        `select_product:${p.id}`
      )]
    );
    buttons.push([Markup.button.callback('Искать другой', 'back_to_search')]);
    buttons.push([Markup.button.callback('Отмена', 'cancel')]);

    await ctx.reply(
      `Найдено (${matches.length}):\nВыбери товар:`,
      Markup.inlineKeyboard(buttons)
    );
    return;
  }

  // ===== ВВОД КОЛИЧЕСТВА =====
  if (state.step === 'enter_quantity') {
    const match = text.match(/^([\d.,]+)\s*(кг|kg|г|g|л|l|шт|pcs)?$/i);

    if (!match) {
      return ctx.reply(
        'Введи количество числом.\nПример: `5` или `5 кг`',
        { parse_mode: 'Markdown' }
      );
    }

    const amount = parseFloat(match[1].replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('Количество должно быть больше 0');
    }

    let unit = (match[2] || state.selectedProduct.mainUnit || 'кг').toLowerCase();
    const unitMap = { 'kg': 'кг', 'g': 'г', 'l': 'л', 'pcs': 'шт' };
    unit = unitMap[unit] || unit;

    const newItem = {
      productId: state.selectedProduct.id,
      name: state.selectedProduct.name,
      amount,
      unit
    };

    const items = [...(state.items || []), newItem];
    const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';

    setUserState(userId, {
      ...state,
      step: 'search_product',
      items,
      selectedProduct: null
    });

    const itemsList = formatItemsList(items);

    await ctx.reply(
      `Добавлено: ${newItem.name} - ${amount} ${unit}\n\n` +
      `Роль: ${roleLabel}\n` +
      `Позиции (${items.length}):\n${itemsList}\n\n` +
      `Введи название следующего товара или нажми "Переместить":`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Переместить', 'finish_adding')],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    );
    return;
  }

  // ===== Если не в процессе =====
  return ctx.reply(
    'Используй /start чтобы начать перемещение.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Кухня', 'role_kitchen')],
      [Markup.button.callback('Склад', 'role_warehouse')]
    ])
  );
});

// ==================== CALLBACK: Выбор товара ====================
bot.action(/^select_product:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const productId = ctx.match[1];
  const product = PRODUCTS.find(p => p.id === productId);
  const state = getUserState(ctx.from.id);

  if (!product) {
    return ctx.editMessageText('Товар не найден. Попробуй поиск заново.');
  }

  setUserState(ctx.from.id, {
    ...state,
    step: 'enter_quantity',
    selectedProduct: product
  });

  await ctx.editMessageText(
    `Выбран: ${product.name}\n\n` +
    `Введи количество (например: 5 или 5 кг):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Назад к поиску', 'back_to_search')],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== CALLBACK: Назад к поиску ====================
bot.action('back_to_search', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx.from.id);

  if (!state.role) {
    return ctx.editMessageText(
      'Сессия истекла. Начни заново.',
      Markup.inlineKeyboard([
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );
  }

  const itemsCount = state.items?.length || 0;
  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';

  setUserState(ctx.from.id, {
    ...state,
    step: 'search_product',
    selectedProduct: null
  });

  let message = `Роль: ${roleLabel}\n`;
  message += `Добавлено позиций: ${itemsCount}\n\n`;
  message += `Введи название товара для поиска:`;

  const buttons = [[Markup.button.callback('Отмена', 'cancel')]];
  if (itemsCount > 0) {
    buttons.unshift([Markup.button.callback('Переместить', 'finish_adding')]);
  }

  await ctx.editMessageText(message, Markup.inlineKeyboard(buttons));
});

// ==================== CALLBACK: Завершить добавление ====================
bot.action('finish_adding', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx.from.id);

  if (!state.role) {
    return ctx.editMessageText(
      'Сессия истекла. Начни заново.',
      Markup.inlineKeyboard([
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );
  }

  const items = state.items || [];

  if (items.length === 0) {
    return ctx.editMessageText(
      'Нет добавленных позиций.\n\nВведи название товара для поиска:',
      Markup.inlineKeyboard([
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    );
  }

  setUserState(ctx.from.id, {
    ...state,
    step: 'confirm'
  });

  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';
  const itemsList = formatItemsList(items);
  const actionText = state.role === 'kitchen'
    ? 'Список будет отправлен в группу.'
    : 'Будет создан документ перемещения в iiko (Кухня -> Склад) + сообщение в группу.';

  await ctx.editMessageText(
    `Роль: ${roleLabel}\n\n` +
    `Позиции (${items.length}):\n${itemsList}\n\n` +
    `${actionText}\n\n` +
    `Подтвердить перемещение?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Переместить', 'confirm_transfer')],
      [Markup.button.callback('+ Добавить ещё', 'back_to_search')],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== CALLBACK: Подтверждение перемещения ====================
bot.action('confirm_transfer', async (ctx) => {
  await ctx.answerCbQuery('Выполняю перемещение...');

  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (state.step !== 'confirm' || !state.items || state.items.length === 0) {
    return ctx.editMessageText('Ошибка состояния. Начни заново с /start');
  }

  const username = ctx.from.username
    ? `@${ctx.from.username}`
    : `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || String(userId);

  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';
  const rawText = state.items.map(item =>
    `${item.name} ${item.amount} ${item.unit}`
  ).join('; ');

  try {
    // 1. Логируем в Google Sheets
    const rowIndex = await sheetsService.appendTransferRow({
      role: roleLabel,
      items: state.items,
      telegramId: userId,
      username,
      rawText
    });

    // 2. Выполняем действие в зависимости от роли
    if (state.role === 'kitchen') {
      // Кухня: только сообщение в группу
      const groupMessage = formatGroupMessage('kitchen', state.items, username);

      await bot.telegram.sendMessage(TRANSFER_GROUP_ID, groupMessage);

      await sheetsService.updateTransferRow(rowIndex, { status: 'SENT' });

      await ctx.editMessageText(
        `Список отправлен в группу!\n\n` +
        `Роль: ${roleLabel}\n` +
        `Позиции (${state.items.length}):\n${formatItemsList(state.items)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Новое перемещение', 'back_to_menu')],
        ])
      );

    } else {
      // Склад: документ в iiko + сообщение в группу
      if (!KITCHEN_STORE_ID || !WAREHOUSE_STORE_ID) {
        await sheetsService.updateTransferRow(rowIndex, {
          status: 'IIKO_ERROR',
          errorMessage: 'Не настроены KITCHEN_STORE_ID или WAREHOUSE_STORE_ID'
        });

        return ctx.editMessageText(
          'Ошибка: не настроены UUID складов для перемещения.\n' +
          'Обратись к администратору.',
          Markup.inlineKeyboard([
            [Markup.button.callback('В меню', 'back_to_menu')]
          ])
        );
      }

      const iikoResult = await iikoService.createTransferDocument({
        storeFrom: KITCHEN_STORE_ID,
        storeTo: WAREHOUSE_STORE_ID,
        items: state.items,
        comment: `Перемещение через Telegram. ${username}`
      });

      if (iikoResult.success) {
        // Отправляем сообщение в группу
        const groupMessage = formatGroupMessage('warehouse', state.items, username) +
          `\n\nДокумент iiko: ${iikoResult.documentNumber || iikoResult.documentId}`;

        await bot.telegram.sendMessage(TRANSFER_GROUP_ID, groupMessage);

        await sheetsService.updateTransferRow(rowIndex, {
          iikoDocumentId: iikoResult.documentId,
          iikoDocumentNumber: iikoResult.documentNumber,
          status: 'IIKO_OK'
        });

        await ctx.editMessageText(
          `Перемещение создано!\n\n` +
          `Роль: ${roleLabel}\n` +
          `Документ iiko: ${iikoResult.documentNumber || iikoResult.documentId}\n\n` +
          `Позиции (${state.items.length}):\n${formatItemsList(state.items)}\n\n` +
          `Сообщение отправлено в группу.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Новое перемещение', 'back_to_menu')],
          ])
        );

      } else {
        const errorMsg = iikoResult.errors?.join(', ') || iikoResult.error || 'Неизвестная ошибка';

        await sheetsService.updateTransferRow(rowIndex, {
          status: 'IIKO_ERROR',
          errorMessage: errorMsg
        });

        await ctx.editMessageText(
          `Ошибка создания документа в iiko!\n\n` +
          `Ошибка: ${errorMsg}\n\n` +
          `Данные сохранены в журнал.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Попробовать снова', 'retry_transfer')],
            [Markup.button.callback('В меню', 'back_to_menu')]
          ])
        );
      }
    }

    clearUserState(userId);

  } catch (error) {
    console.error('Error in confirm_transfer:', error);

    await ctx.editMessageText(
      `Произошла ошибка: ${error.message}\n\nПопробуй ещё раз.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );

    clearUserState(userId);
  }
});

// ==================== CALLBACK: Повторить перемещение ====================
bot.action('retry_transfer', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx.from.id);

  if (!state.items || state.items.length === 0) {
    return ctx.editMessageText(
      'Нет данных для повтора. Начни заново.',
      Markup.inlineKeyboard([
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );
  }

  setUserState(ctx.from.id, {
    ...state,
    step: 'confirm'
  });

  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';
  const itemsList = formatItemsList(state.items);

  await ctx.editMessageText(
    `Повторная попытка...\n\n` +
    `Роль: ${roleLabel}\n\n` +
    `Позиции (${state.items.length}):\n${itemsList}\n\n` +
    `Подтвердить перемещение?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Переместить', 'confirm_transfer')],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== CALLBACK: История перемещений ====================
bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    const transfers = await sheetsService.getRecentTransfers(ctx.from.id, 5);

    if (transfers.length === 0) {
      return ctx.editMessageText(
        'У тебя пока нет перемещений.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Кухня', 'role_kitchen')],
          [Markup.button.callback('Склад', 'role_warehouse')],
          [Markup.button.callback('В меню', 'back_to_menu')]
        ])
      );
    }

    let historyText = 'Последние перемещения:\n\n';

    for (const t of transfers) {
      const statusEmoji = (t.status === 'IIKO_OK' || t.status === 'SENT') ? '✅' : t.status === 'IIKO_ERROR' ? '❌' : '⏳';
      historyText += `${statusEmoji} ${t.timestamp}\n`;
      historyText += `Роль: ${t.role}\n`;
      const shortText = (t.rawText || '').substring(0, 50) + ((t.rawText?.length || 0) > 50 ? '...' : '');
      if (shortText) {
        historyText += `${shortText}\n`;
      }
      if (t.iikoDocNumber || t.iikoDocumentId) {
        historyText += `Doc: ${t.iikoDocNumber || t.iikoDocumentId}\n`;
      }
      historyText += '\n';
    }

    await ctx.editMessageText(
      historyText,
      Markup.inlineKeyboard([
        [Markup.button.callback('Кухня', 'role_kitchen')],
        [Markup.button.callback('Склад', 'role_warehouse')],
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
      [Markup.button.callback('Кухня', 'role_kitchen')],
      [Markup.button.callback('Склад', 'role_warehouse')],
      [Markup.button.callback('В меню', 'back_to_menu')]
    ])
  );
});

// ==================== CALLBACK: Назад в меню ====================
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  clearUserState(ctx.from.id);

  await ctx.editMessageText(
    'Главное меню.\n\nВыбери роль:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Кухня', 'role_kitchen')],
      [Markup.button.callback('Склад', 'role_warehouse')],
      [Markup.button.callback('История перемещений', 'history')]
    ])
  );
});

// ==================== ЕЖЕДНЕВНЫЙ ОТЧЁТ ====================

async function sendDailyReport() {
  try {
    console.log('Generating daily report...');

    const stats = await sheetsService.getTodayTransfers();

    const today = new Date().toLocaleDateString('ru-RU', {
      timeZone: 'Asia/Novosibirsk',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    let message = `Отчёт по перемещениям за ${today}\n\n`;

    if (stats.total === 0) {
      message += `Перемещений за сегодня не было.`;
    } else {
      message += `Всего перемещений: ${stats.total}\n`;
      message += `Успешно: ${stats.success}\n`;
      if (stats.errors > 0) {
        message += `Ошибок: ${stats.errors}\n`;
      }
      if (stats.pending > 0) {
        message += `В обработке: ${stats.pending}\n`;
      }

      // По ролям
      message += `\nПо ролям:\n`;
      for (const [role, count] of Object.entries(stats.byRole)) {
        if (count > 0) {
          message += `  ${role}: ${count}\n`;
        }
      }

      // Последние 5 перемещений
      if (stats.items.length > 0) {
        message += `\nПоследние перемещения:\n`;
        const lastItems = stats.items.slice(-5).reverse();
        for (const item of lastItems) {
          const statusIcon = (item.status === 'IIKO_OK' || item.status === 'SENT') ? '✅' : item.status === 'IIKO_ERROR' ? '❌' : '⏳';
          const shortMsg = item.rawText.length > 40
            ? item.rawText.substring(0, 40) + '...'
            : item.rawText;
          message += `${statusIcon} [${item.role}] ${shortMsg}\n`;
        }
      }
    }

    await bot.telegram.sendMessage(TRANSFER_GROUP_ID, message);
    console.log('Daily report sent to group');

  } catch (error) {
    console.error('Error sending daily report:', error.message);
  }
}

// Крон-задача: каждый день в 21:30 по Новосибирску
cron.schedule('30 21 * * *', async () => {
  console.log('Running daily report cron job...');
  try {
    await sendDailyReport();
    console.log('Daily report cron job completed successfully');
  } catch (error) {
    console.error('Daily report cron job failed:', error.message);
  }
}, {
  timezone: 'Asia/Novosibirsk'
});

console.log('Daily report scheduled for 21:30 Novosibirsk time (Asia/Novosibirsk)');

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
    await sheetsService.ensureSheetExists();
    console.log('Google Sheets ready');

    console.log('Connecting to iiko Server API...');
    const productsLoaded = await loadProducts();

    if (productsLoaded) {
      console.log('iiko references loaded successfully');
      console.log(`  Products: ${PRODUCTS.length}`);
    } else {
      console.warn('Warning: Could not load products. Will retry on first request.');
    }

    if (KITCHEN_STORE_ID) {
      console.log(`Kitchen store ID: ${KITCHEN_STORE_ID}`);
    } else {
      console.warn('Warning: KITCHEN_STORE_ID not set');
    }

    if (WAREHOUSE_STORE_ID) {
      console.log(`Warehouse store ID: ${WAREHOUSE_STORE_ID}`);
    } else {
      console.warn('Warning: WAREHOUSE_STORE_ID not set');
    }

    bot.launch().then(() => {
      console.log('Bot polling started');
    });

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
