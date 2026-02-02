const { google } = require('googleapis');

/**
 * Сервис для работы с Google Sheets API
 * Журнал операций списания
 *
 * Структура листа "Writeoff Logs":
 * A: timestamp        - Дата и время создания
 * B: store_id         - ID склада
 * C: store_name       - Название склада
 * D: account_id       - ID расходного счета
 * E: account_name     - Название расходного счета
 * F: raw_message      - Исходное сообщение от кладовщика
 * G: parsed_items     - Распарсенные позиции (JSON)
 * H: telegram_id      - Telegram ID кладовщика
 * I: iiko_document_id - ID документа в iiko
 * J: iiko_doc_number  - Номер документа в iiko
 * K: status           - Статус: NEW, IIKO_OK, IIKO_ERROR
 * L: error_message    - Сообщение об ошибке (если есть)
 */
class GoogleSheetsService {
  constructor(serviceAccountJson, spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheetName = 'Writeoff Logs';

    // Инициализация Google Auth
    this.auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  /**
   * Инициализация листа с заголовками (если нужно)
   */
  async ensureSheetExists() {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });

      const sheetExists = response.data.sheets.some(
        sheet => sheet.properties.title === this.sheetName
      );

      if (!sheetExists) {
        // Создаем лист
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          resource: {
            requests: [{
              addSheet: {
                properties: { title: this.sheetName }
              }
            }]
          }
        });

        // Добавляем заголовки
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!A1:L1`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              'Timestamp',
              'Store ID',
              'Store Name',
              'Account ID',
              'Account Name',
              'Raw Message',
              'Parsed Items',
              'Telegram ID',
              'iiko Document ID',
              'iiko Doc Number',
              'Status',
              'Error Message'
            ]]
          }
        });

        console.log(`Sheet "${this.sheetName}" created with headers`);
      }
    } catch (error) {
      console.error('Error ensuring sheet exists:', error.message);
      throw error;
    }
  }

  /**
   * Добавить запись о списании
   * @param {Object} payload - Данные списания
   * @returns {Promise<number>} - Индекс добавленной строки
   */
  async appendWriteoffRow(payload) {
    const {
      storeId,
      storeName,
      accountId,
      accountName,
      rawMessage,
      parsedItems,
      telegramId
    } = payload;

    const timestamp = new Date().toLocaleString('ru-RU', {
      timeZone: 'Asia/Novosibirsk',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const values = [
      timestamp,                              // A: timestamp
      storeId || '',                          // B: store_id
      storeName || '',                        // C: store_name
      accountId || '',                        // D: account_id
      accountName || '',                      // E: account_name
      rawMessage || '',                       // F: raw_message
      JSON.stringify(parsedItems),            // G: parsed_items
      String(telegramId),                     // H: telegram_id
      '',                                     // I: iiko_document_id
      '',                                     // J: iiko_doc_number
      'NEW',                                  // K: status
      ''                                      // L: error_message
    ];

    try {
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A:L`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });

      // Извлекаем номер строки из ответа
      const updatedRange = response.data.updates.updatedRange;
      const match = updatedRange.match(/!A(\d+):/);
      const rowIndex = match ? parseInt(match[1]) : null;

      console.log(`Writeoff logged at row ${rowIndex}`);

      return rowIndex;
    } catch (error) {
      console.error('Error appending writeoff row:', error.message);
      throw error;
    }
  }

  /**
   * Обновить статус записи списания
   * @param {number} rowIndex - Номер строки
   * @param {Object} updates - Обновления { iikoDocumentId, iikoDocumentNumber, status, errorMessage }
   */
  async updateWriteoffRow(rowIndex, updates) {
    const { iikoDocumentId, iikoDocumentNumber, status, errorMessage } = updates;

    try {
      const data = [];

      // I: iiko_document_id
      if (iikoDocumentId !== undefined) {
        data.push({
          range: `${this.sheetName}!I${rowIndex}`,
          values: [[iikoDocumentId || '']]
        });
      }

      // J: iiko_doc_number
      if (iikoDocumentNumber !== undefined) {
        data.push({
          range: `${this.sheetName}!J${rowIndex}`,
          values: [[iikoDocumentNumber || '']]
        });
      }

      // K: status
      if (status !== undefined) {
        data.push({
          range: `${this.sheetName}!K${rowIndex}`,
          values: [[status]]
        });
      }

      // L: error_message
      if (errorMessage !== undefined) {
        data.push({
          range: `${this.sheetName}!L${rowIndex}`,
          values: [[errorMessage || '']]
        });
      }

      if (data.length > 0) {
        await this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          resource: {
            valueInputOption: 'USER_ENTERED',
            data
          }
        });

        console.log(`Writeoff row ${rowIndex} updated: status=${status}`);
      }
    } catch (error) {
      console.error('Error updating writeoff row:', error.message);
      throw error;
    }
  }

  /**
   * Получить последние записи списания для пользователя
   * @param {number} telegramId - Telegram ID
   * @param {number} limit - Количество записей
   */
  async getRecentWriteoffs(telegramId, limit = 5) {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A2:L1000`,
        valueRenderOption: 'FORMATTED_VALUE'
      });

      const rows = response.data.values || [];
      const telegramIdStr = String(telegramId);

      // Фильтруем по telegram_id (колонка H, индекс 7) и берем последние
      const userRows = rows
        .filter(row => row[7] === telegramIdStr)
        .slice(-limit)
        .reverse();

      return userRows.map(row => ({
        timestamp: row[0],          // A
        storeName: row[2],          // C
        accountName: row[4],        // E
        rawMessage: row[5],         // F
        iikoDocumentId: row[8],     // I
        iikoDocNumber: row[9],      // J
        status: row[10],            // K
        errorMessage: row[11]       // L
      }));
    } catch (error) {
      console.error('Error getting recent writeoffs:', error.message);
      return [];
    }
  }

  /**
   * Получить все списания за сегодня (по времени Новосибирска)
   * @returns {Promise<Object>} - Статистика за день
   */
  async getTodayWriteoffs() {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A2:L10000`,
        valueRenderOption: 'FORMATTED_VALUE'
      });

      const rows = response.data.values || [];

      // Получаем сегодняшнюю дату по Новосибирску
      const today = new Date().toLocaleDateString('ru-RU', {
        timeZone: 'Asia/Novosibirsk',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      // Фильтруем записи за сегодня (timestamp в колонке A начинается с даты)
      const todayRows = rows.filter(row => {
        const timestamp = row[0] || '';
        return timestamp.startsWith(today);
      });

      // Считаем статистику
      const stats = {
        total: todayRows.length,
        success: 0,
        errors: 0,
        pending: 0,
        byStore: {},
        byAccount: {},
        items: []
      };

      for (const row of todayRows) {
        const storeName = row[2] || 'Неизвестный склад';
        const accountName = row[4] || 'Без счёта';
        const status = row[10] || 'NEW';
        const rawMessage = row[5] || '';
        const docNumber = row[9] || '';

        // Считаем статусы
        if (status === 'IIKO_OK') stats.success++;
        else if (status === 'IIKO_ERROR') stats.errors++;
        else stats.pending++;

        // Группируем по складам
        stats.byStore[storeName] = (stats.byStore[storeName] || 0) + 1;

        // Группируем по счетам
        stats.byAccount[accountName] = (stats.byAccount[accountName] || 0) + 1;

        // Добавляем в список
        stats.items.push({
          timestamp: row[0],
          storeName,
          accountName,
          rawMessage,
          status,
          docNumber
        });
      }

      return stats;
    } catch (error) {
      console.error('Error getting today writeoffs:', error.message);
      return { total: 0, success: 0, errors: 0, pending: 0, byStore: {}, byAccount: {}, items: [] };
    }
  }
}

module.exports = GoogleSheetsService;
