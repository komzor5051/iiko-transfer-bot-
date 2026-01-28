# iiko Writeoff Bot

Telegram-бот для кладовщиков для создания актов списания в iiko.

## Функционал

- Выбор склада/кухни из предустановленного списка
- Парсинг текстового сообщения с позициями для списания
- Создание акта списания в iiko через API
- Логирование всех операций в Google Sheets
- История списаний пользователя

## Быстрый старт

1. Установи зависимости:
```bash
npm install
```

2. Настрой переменные окружения в `.env`:
```
TELEGRAM_BOT_TOKEN=...
GOOGLE_SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON=...
IIKO_API_KEY=...
```

3. Запусти бота:
```bash
npm start
```

## Настройка складов

Отредактируй массив `STORES` в `src/index.js`:

```javascript
const STORES = [
  { id: 'real_store_id_from_iiko', name: 'Основной склад' },
  { id: 'kitchen_id', name: 'Кухня' },
  // ...
];
```

ID складов можно получить через iiko API или из интерфейса iikoOffice.

## Структура Google Sheets

Бот автоматически создает лист "Writeoff Logs" со столбцами:
- A: Timestamp
- B: Store ID
- C: Store Name
- D: Raw Message
- E: Parsed Items (JSON)
- F: Telegram ID
- G: iiko Document ID
- H: Status (NEW, IIKO_OK, IIKO_ERROR)
- I: Error Message

## Формат ввода позиций

Поддерживаемые форматы:
```
помидор 5 кг; огурец 3 кг; курица филе 10 кг
```

или

```
помидор 5 кг
огурец 3 кг
курица филе 10 кг
```

Единицы измерения: кг, г, л, шт (или kg, g, l, pcs)

## iiko API

Текущая реализация использует заглушку для тестирования. Для реального подключения к iiko API:

1. Уточните эндпоинт для создания актов списания в документации iiko
2. Раскомментируйте код в `src/services/iikoService.js`
3. Настройте сопоставление названий продуктов с ID номенклатуры iiko

Документация iiko API: https://ru.iiko.help/articles/api-documentations/

## Команды бота

- `/start` - Главное меню
- `/writeoff` - Создать акт списания
- `/help` - Справка

## Технологии

- Node.js
- Telegraf (Telegram Bot API)
- googleapis (Google Sheets)
- axios (HTTP клиент)
