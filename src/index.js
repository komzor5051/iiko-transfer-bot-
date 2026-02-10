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

// ==================== КАТАЛОГ ТОВАРОВ ПО КАТЕГОРИЯМ ====================
const CATALOG = [
  {
    name: 'Овощи',
    products: [
      'Лук красный', 'Халапеньо', 'Огурцы', 'Помидоры',
      'Картофель фри с/м', 'Лимоны'
    ]
  },
  {
    name: 'Бакалея',
    products: ['Сахар', 'Соль', 'Сахар в стиках 5 г', 'Уксус столовый 9%']
  },
  {
    name: 'Прочее',
    products: ['Вода 19 л', 'Масло фритюрное', 'Лаваш стандартный']
  },
  {
    name: 'Соуса',
    products: ['Копченый', 'Фирменный соус']
  },
  {
    name: 'Молочка/мясо',
    products: ['Молоко', 'Сырный продукт', 'Люля куриный', 'Бедро куриное п/ф', 'Наггетсы']
  },
  {
    name: 'Морсы 0,33',
    products: ['Вишня', 'Апельсин', 'Яблоко']
  },
  {
    name: 'Чаи',
    products: ['Чай/кофе', 'Кофе в зернах', 'Чай зеленый', 'Чай черный Грин Филд']
  }
];

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

/**
 * Найти товар в iiko по названию из каталога
 */
function findProductInIiko(catalogName) {
  const search = catalogName.toLowerCase().trim();

  // Точное совпадение
  let product = PRODUCTS.find(p => p.name.toLowerCase() === search);
  if (product) return product;

  // Частичное совпадение
  product = PRODUCTS.find(p =>
    p.name.toLowerCase().includes(search) || search.includes(p.name.toLowerCase())
  );
  return product || null;
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

function formatItemsList(items) {
  return items.map((item, i) =>
    `${i + 1}. ${item.name} - ${item.amount} ${item.unit}`
  ).join('\n');
}

function formatGroupMessage(role, items, username) {
  const direction = role === 'kitchen'
    ? 'Кухня запрашивает товары'
    : 'Перемещение: Склад -> Кухня';

  let message = `📦 ${direction}\n`;
  message += `👤 ${username}\n\n`;
  message += items.map((item, i) =>
    `${i + 1}. ${item.name} — ${item.amount} ${item.unit}`
  ).join('\n');

  return message;
}

/**
 * Показать список категорий
 */
function getCategoriesKeyboard(itemsCount) {
  const buttons = CATALOG.map((cat, i) =>
    [Markup.button.callback(cat.name, `cat:${i}`)]
  );
  if (itemsCount > 0) {
    buttons.push([Markup.button.callback(`Переместить (${itemsCount})`, 'finish_adding')]);
  }
  buttons.push([Markup.button.callback('Отмена', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
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
    '2. Выбери категорию товаров\n' +
    '3. Выбери товар из списка\n' +
    '4. Введи количество (например: 5 или 5 кг)\n' +
    '5. Нажми "Добавить ещё" или "Переместить"\n\n' +
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

// ==================== КОМАНДА /stores (debug) ====================
bot.command('stores', async (ctx) => {
  try {
    await ctx.reply('Загружаю список складов из iiko...');
    const stores = await iikoService.getStores();

    if (!stores || stores.length === 0) {
      return ctx.reply('Складов не найдено.');
    }

    let msg = `Склады iiko (${stores.length}):\n\n`;
    for (const store of stores) {
      const name = store.name || store['@_name'] || 'Без имени';
      const id = store.id || store['@_id'] || '?';
      const parentId = store.parentId || store['@_parentId'] || '';
      msg += `${name}\nID: ${id}\n`;
      if (parentId) msg += `Parent: ${parentId}\n`;
      msg += '\n';
    }

    // Telegram ограничивает сообщение 4096 символами
    if (msg.length > 4000) {
      const chunks = msg.match(/[\s\S]{1,4000}/g);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(msg);
    }
  } catch (error) {
    console.error('Error in /stores:', error.message);
    await ctx.reply(`Ошибка: ${error.message}`);
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

async function startTransferFlow(ctx, role) {
  const userId = ctx.from.id;

  if (PRODUCTS.length === 0) {
    await ctx.editMessageText('Загружаю номенклатуру из iiko...');
    await loadProducts();
  }

  if (PRODUCTS.length === 0) {
    return ctx.editMessageText(
      'Не удалось загрузить номенклатуру из iiko.\nНажми /refresh.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Попробовать снова', role === 'kitchen' ? 'role_kitchen' : 'role_warehouse')],
        [Markup.button.callback('В меню', 'back_to_menu')]
      ])
    );
  }

  const roleLabel = role === 'kitchen' ? 'Кухня' : 'Склад';

  setUserState(userId, {
    step: 'select_category',
    role,
    items: []
  });

  await ctx.editMessageText(
    `Роль: ${roleLabel}\nДобавлено: 0\n\nВыбери категорию:`,
    getCategoriesKeyboard(0)
  );
}

// ==================== CALLBACK: Выбор категории ====================
bot.action(/^cat:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const catIndex = parseInt(ctx.match[1]);
  const category = CATALOG[catIndex];
  const state = getUserState(ctx.from.id);

  if (!category || !state.role) {
    return ctx.editMessageText('Ошибка. Начни заново /start');
  }

  const buttons = category.products.map((name, i) =>
    [Markup.button.callback(name, `prod:${catIndex}:${i}`)]
  );
  buttons.push([Markup.button.callback('« Назад к категориям', 'back_to_cats')]);

  await ctx.editMessageText(
    `${category.name}:\n\nВыбери товар:`,
    Markup.inlineKeyboard(buttons)
  );
});

// ==================== CALLBACK: Выбор товара ====================
bot.action(/^prod:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const catIndex = parseInt(ctx.match[1]);
  const prodIndex = parseInt(ctx.match[2]);
  const category = CATALOG[catIndex];
  const state = getUserState(ctx.from.id);

  if (!category || !category.products[prodIndex] || !state.role) {
    return ctx.editMessageText('Ошибка. Начни заново /start');
  }

  const catalogName = category.products[prodIndex];
  const iikoProduct = findProductInIiko(catalogName);

  setUserState(ctx.from.id, {
    ...state,
    step: 'enter_quantity',
    selectedProduct: {
      id: iikoProduct?.id || null,
      name: catalogName,
      mainUnit: iikoProduct?.mainUnit || 'кг'
    }
  });

  let msg = `Выбран: ${catalogName}`;
  if (!iikoProduct) {
    msg += `\n(не найден в iiko — будет записан только в журнал)`;
  }
  msg += `\n\nВведи количество (например: 5 или 5 кг):`;

  await ctx.editMessageText(msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('« Назад', `cat:${catIndex}`)],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ ====================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  // ===== ВВОД КОЛИЧЕСТВА =====
  if (state.step === 'enter_quantity') {
    const match = text.match(/^([\d.,]+)\s*(кг|kg|г|g|л|l|шт|pcs|порц)?$/i);

    if (!match) {
      return ctx.reply(
        'Введи количество числом.\nПример: 5 или 5 кг',
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
      step: 'select_category',
      items,
      selectedProduct: null
    });

    const itemsList = formatItemsList(items);

    await ctx.reply(
      `Добавлено: ${newItem.name} - ${amount} ${unit}\n\n` +
      `Роль: ${roleLabel}\n` +
      `Позиции (${items.length}):\n${itemsList}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Переместить (${items.length})`, 'finish_adding')],
        [Markup.button.callback('Добавить ещё', 'back_to_cats')],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    );
    return;
  }

  // ===== Если не в процессе =====
  return ctx.reply(
    'Используй /start чтобы начать.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Кухня', 'role_kitchen')],
      [Markup.button.callback('Склад', 'role_warehouse')]
    ])
  );
});

// ==================== CALLBACK: Назад к категориям ====================
bot.action('back_to_cats', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx.from.id);

  if (!state.role) {
    return ctx.editMessageText(
      'Сессия истекла. Начни заново.',
      Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
    );
  }

  const itemsCount = state.items?.length || 0;
  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';

  setUserState(ctx.from.id, {
    ...state,
    step: 'select_category',
    selectedProduct: null
  });

  await ctx.editMessageText(
    `Роль: ${roleLabel}\nДобавлено: ${itemsCount}\n\nВыбери категорию:`,
    getCategoriesKeyboard(itemsCount)
  );
});

// ==================== CALLBACK: Завершить добавление ====================
bot.action('finish_adding', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx.from.id);

  if (!state.role) {
    return ctx.editMessageText(
      'Сессия истекла. Начни заново.',
      Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
    );
  }

  const items = state.items || [];

  if (items.length === 0) {
    return ctx.editMessageText(
      'Нет добавленных позиций.\n\nВыбери категорию:',
      getCategoriesKeyboard(0)
    );
  }

  setUserState(ctx.from.id, { ...state, step: 'confirm' });

  const roleLabel = state.role === 'kitchen' ? 'Кухня' : 'Склад';
  const itemsList = formatItemsList(items);
  const actionText = state.role === 'kitchen'
    ? 'Список будет отправлен в группу.'
    : 'Будет создан документ перемещения в iiko + сообщение в группу.';

  await ctx.editMessageText(
    `Роль: ${roleLabel}\n\n` +
    `Позиции (${items.length}):\n${itemsList}\n\n` +
    `${actionText}\n\nПодтвердить?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Переместить', 'confirm_transfer')],
      [Markup.button.callback('+ Добавить ещё', 'back_to_cats')],
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
    const rowIndex = await sheetsService.appendTransferRow({
      role: roleLabel,
      items: state.items,
      telegramId: userId,
      username,
      rawText
    });

    if (state.role === 'kitchen') {
      const groupMessage = formatGroupMessage('kitchen', state.items, username);
      await bot.telegram.sendMessage(TRANSFER_GROUP_ID, groupMessage);

      await sheetsService.updateTransferRow(rowIndex, { status: 'SENT' });

      await ctx.editMessageText(
        `Перемещение отправлено в группу!\n\n` +
        `Позиции (${state.items.length}):\n${formatItemsList(state.items)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Новое перемещение', 'back_to_menu')],
        ])
      );

    } else {
      if (!KITCHEN_STORE_ID || !WAREHOUSE_STORE_ID) {
        await sheetsService.updateTransferRow(rowIndex, {
          status: 'IIKO_ERROR',
          errorMessage: 'Не настроены KITCHEN_STORE_ID или WAREHOUSE_STORE_ID'
        });
        return ctx.editMessageText(
          'Ошибка: не настроены UUID складов.\nОбратись к администратору.',
          Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
        );
      }

      const validItems = state.items.filter(item => item.productId);
      const skippedItems = state.items.filter(item => !item.productId);

      if (validItems.length === 0) {
        await sheetsService.updateTransferRow(rowIndex, {
          status: 'IIKO_ERROR',
          errorMessage: 'Ни один товар не найден в iiko'
        });

        // Всё равно отправляем в группу как текст
        const groupMessage = formatGroupMessage('warehouse', state.items, username);
        await bot.telegram.sendMessage(TRANSFER_GROUP_ID, groupMessage);

        return ctx.editMessageText(
          'Ни один товар не найден в iiko.\nСписок отправлен в группу как текст.',
          Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
        );
      }

      const iikoResult = await iikoService.createTransferDocument({
        storeFrom: WAREHOUSE_STORE_ID,
        storeTo: KITCHEN_STORE_ID,
        items: validItems,
        comment: `Перемещение через Telegram. ${username}`
      });

      if (iikoResult.success) {
        const groupMessage = formatGroupMessage('warehouse', state.items, username) +
          `\n\nДокумент iiko: ${iikoResult.documentNumber || iikoResult.documentId}`;
        await bot.telegram.sendMessage(TRANSFER_GROUP_ID, groupMessage);

        await sheetsService.updateTransferRow(rowIndex, {
          iikoDocumentId: iikoResult.documentId,
          iikoDocumentNumber: iikoResult.documentNumber,
          status: 'IIKO_OK'
        });

        let successMsg = `Перемещение создано!\n\n` +
          `Документ iiko: ${iikoResult.documentNumber || iikoResult.documentId}\n\n` +
          `Позиции (${validItems.length}):\n${formatItemsList(validItems)}`;

        if (skippedItems.length > 0) {
          successMsg += `\n\nПропущено (нет в iiko):\n` +
            skippedItems.map(i => `- ${i.name}`).join('\n');
        }

        await ctx.editMessageText(successMsg,
          Markup.inlineKeyboard([[Markup.button.callback('Новое перемещение', 'back_to_menu')]])
        );
      } else {
        const errorMsg = iikoResult.errors?.join(', ') || iikoResult.error || 'Неизвестная ошибка';
        await sheetsService.updateTransferRow(rowIndex, {
          status: 'IIKO_ERROR',
          errorMessage: errorMsg
        });

        await ctx.editMessageText(
          `Ошибка iiko: ${errorMsg}\n\nДанные сохранены в журнал.`,
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
      `Ошибка: ${error.message}\n\nПопробуй ещё раз.`,
      Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
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
      'Нет данных для повтора.',
      Markup.inlineKeyboard([[Markup.button.callback('В меню', 'back_to_menu')]])
    );
  }

  setUserState(ctx.from.id, { ...state, step: 'confirm' });

  await ctx.editMessageText(
    `Повторная попытка...\n\nПозиции (${state.items.length}):\n${formatItemsList(state.items)}\n\nПодтвердить?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Переместить', 'confirm_transfer')],
      [Markup.button.callback('Отмена', 'cancel')]
    ])
  );
});

// ==================== CALLBACK: История ====================
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
      if (shortText) historyText += `${shortText}\n`;
      if (t.iikoDocNumber || t.iikoDocumentId) historyText += `Doc: ${t.iikoDocNumber || t.iikoDocumentId}\n`;
      historyText += '\n';
    }

    await ctx.editMessageText(historyText,
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
      message += `Всего: ${stats.total}\n`;
      message += `Успешно: ${stats.success}\n`;
      if (stats.errors > 0) message += `Ошибок: ${stats.errors}\n`;
      if (stats.pending > 0) message += `В обработке: ${stats.pending}\n`;

      message += `\nПо ролям:\n`;
      for (const [role, count] of Object.entries(stats.byRole)) {
        if (count > 0) message += `  ${role}: ${count}\n`;
      }

      if (stats.items.length > 0) {
        message += `\nПоследние:\n`;
        const lastItems = stats.items.slice(-5).reverse();
        for (const item of lastItems) {
          const icon = (item.status === 'IIKO_OK' || item.status === 'SENT') ? '✅' : item.status === 'IIKO_ERROR' ? '❌' : '⏳';
          const shortMsg = item.rawText.length > 40 ? item.rawText.substring(0, 40) + '...' : item.rawText;
          message += `${icon} [${item.role}] ${shortMsg}\n`;
        }
      }
    }

    await bot.telegram.sendMessage(TRANSFER_GROUP_ID, message);
    console.log('Daily report sent to group');
  } catch (error) {
    console.error('Error sending daily report:', error.message);
  }
}

cron.schedule('30 21 * * *', async () => {
  console.log('Running daily report cron job...');
  try {
    await sendDailyReport();
    console.log('Daily report cron job completed successfully');
  } catch (error) {
    console.error('Daily report cron job failed:', error.message);
  }
}, { timezone: 'Asia/Novosibirsk' });

console.log('Daily report scheduled for 21:30 Novosibirsk time');

// ==================== GRACEFUL SHUTDOWN ====================
process.once('SIGINT', () => { console.log('SIGINT'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { console.log('SIGTERM'); bot.stop('SIGTERM'); });

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    await sheetsService.ensureSheetExists();
    console.log('Google Sheets ready');

    console.log('Connecting to iiko Server API...');
    const productsLoaded = await loadProducts();

    if (productsLoaded) {
      console.log(`Products: ${PRODUCTS.length}`);

      // Проверяем сопоставление каталога с iiko
      let matched = 0;
      let unmatched = [];
      for (const cat of CATALOG) {
        for (const name of cat.products) {
          if (findProductInIiko(name)) {
            matched++;
          } else {
            unmatched.push(name);
          }
        }
      }
      console.log(`Catalog: ${matched} matched, ${unmatched.length} unmatched`);
      if (unmatched.length > 0) {
        console.log('Unmatched:', unmatched.join(', '));
      }
    } else {
      console.warn('Warning: Could not load products.');
    }

    if (KITCHEN_STORE_ID) console.log(`Kitchen store: ${KITCHEN_STORE_ID}`);
    else console.warn('Warning: KITCHEN_STORE_ID not set');

    if (WAREHOUSE_STORE_ID) console.log(`Warehouse store: ${WAREHOUSE_STORE_ID}`);
    else console.warn('Warning: WAREHOUSE_STORE_ID not set');

    bot.launch().then(() => console.log('Bot polling started'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('Bot started successfully!');

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

start();
