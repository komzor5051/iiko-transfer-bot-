const { Telegraf } = require('telegraf');
const config = require('./config/env');

// Создаем экземпляр бота
const bot = new Telegraf(config.telegramBotToken);

// Middleware для логирования
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  const user = ctx.from?.username || ctx.from?.id;
  const action = ctx.updateType;

  console.log(`[${new Date().toISOString()}] ${user} - ${action} (${ms}ms)`);
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
  ctx.reply('Произошла ошибка. Попробуй ещё раз.').catch(() => {});
});

module.exports = bot;
