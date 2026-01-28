# TODO: iiko Writeoff Bot

## Что осталось до финала

### 1. Получить доступ к iikoServer API
- [ ] Узнать адрес iikoServer (из iikoOffice → Администрирование → Настройки)
- [ ] Или написать в поддержку iiko (api@iiko.ru) и запросить:
  - Адрес REST API для организации ".Шаурма" (ID: `80084ecd-a9d5-4144-ba6f-b423f194d3c4`)
  - Учетные данные для `/resto/api/v2/`

### 2. Получить ID складов и счетов
- [ ] `storeId` — ID склада откуда списываем
- [ ] `accountId` — ID счета списания (статья расхода)

Эндпоинты для получения:
```
GET /resto/api/v2/entities/stores — список складов
GET /resto/api/v2/entities/accounts — список счетов
```

### 3. Обновить iikoService.js
- [ ] Заменить mock на реальный эндпоинт: `POST /resto/api/v2/documents/writeoff`
- [ ] Добавить авторизацию для iikoServer API
- [ ] Обновить `.env` с новыми переменными:
  ```
  IIKO_SERVER_URL=https://xxx.iiko.ru:9080
  IIKO_SERVER_LOGIN=...
  IIKO_SERVER_PASSWORD=...
  ```

### 4. Маппинг продуктов
- [ ] Загрузить номенклатуру из iiko (уже есть 35 продуктов)
- [ ] Создать функцию сопоставления названия → productId
- [ ] Можно использовать fuzzy search для похожих названий

### 5. Тестирование
- [ ] Создать тестовый акт списания
- [ ] Проверить, что документ появился в iikoOffice

### 6. Деплой
- [ ] Задеплоить на Railway / VPS / сервер
- [ ] Настроить автозапуск (PM2 / systemd)

---

## Что уже готово

- [x] Telegram бот работает (@shrmtransferbot)
- [x] Парсинг позиций из текста ("помидор 5 кг; огурец 3 кг")
- [x] Логирование в Google Sheets (лист "Writeoff Logs")
- [x] Интеграция с iiko Cloud API
- [x] Получена организация: `.Шаурма`
- [x] Получена точка: `Шаурма на углях`
- [x] Получена номенклатура: 35 продуктов

---

## Данные iiko (уже получены)

```
Организация ID: 80084ecd-a9d5-4144-ba6f-b423f194d3c4
Организация: .Шаурма
Адрес: Новосибирск, Дзержинского, д 2/2

Terminal Group ID: 46c96614-eae6-4f70-ba38-86c940205dc8
Terminal Group: Шаурма на углях
```

---

## Формат запроса для акта списания

**Эндпоинт:** `POST https://host:port/resto/api/v2/documents/writeoff`

**Тело запроса:**
```json
{
  "dateIncoming": "2024-01-19T12:00",
  "status": "NEW",
  "comment": "Списание через бот",
  "storeId": "xxx-xxx-xxx",
  "accountId": "xxx-xxx-xxx",
  "items": [
    {
      "productId": "xxx-xxx-xxx",
      "amount": 5
    }
  ]
}
```

**Ответ при успехе:**
```json
{
  "result": "SUCCESS",
  "response": {
    "id": "документ-id",
    "documentNumber": "123"
  }
}
```

---

## Контакты

- iiko API поддержка: api@iiko.ru
- Документация: https://ru.iiko.help/articles/api-documentations/akty-spisaniya
