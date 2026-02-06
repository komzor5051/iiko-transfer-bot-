require('dotenv').config();

/**
 * Валидация и экспорт переменных окружения
 */

const requiredVars = [
  'TELEGRAM_BOT_TOKEN',
  'GOOGLE_SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'IIKO_PASSWORD'  // Пароль для iiko Server API
];

// Проверяем наличие обязательных переменных
for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

// Парсим Google Service Account JSON
let googleServiceAccount;
try {
  googleServiceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (error) {
  console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', error.message);
  process.exit(1);
}

// Парсим список админов
const adminIds = process.env.ADMIN_TELEGRAM_IDS
  ? process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

module.exports = {
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  adminTelegramIds: adminIds,

  // Google Sheets
  googleSheetId: process.env.GOOGLE_SHEET_ID,
  googleServiceAccount,

  // iiko Server API (REST API v2)
  iiko: {
    baseUrl: process.env.IIKO_BASE_URL || 'https://shaurma-dzerzhinskogo-2-2.iiko.it:443/resto',
    login: process.env.IIKO_LOGIN || 'Artem',
    password: process.env.IIKO_PASSWORD || ''
  },

  // Склады для перемещений
  kitchenStoreId: process.env.KITCHEN_STORE_ID || '',
  warehouseStoreId: process.env.WAREHOUSE_STORE_ID || '',

  // Telegram группа для уведомлений о перемещениях
  transferGroupId: process.env.TRANSFER_GROUP_ID ? Number(process.env.TRANSFER_GROUP_ID) : null,

  // Environment
  nodeEnv: process.env.NODE_ENV || 'development'
};
