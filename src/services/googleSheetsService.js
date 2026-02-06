const { google } = require('googleapis');

/**
 * Сервис для работы с Google Sheets API
 * Журнал перемещений
 *
 * Структура листа "Transfer Logs":
 * A: timestamp        - Дата и время
 * B: role             - Роль (Кухня / Склад)
 * C: items_json       - Позиции (JSON)
 * D: telegram_id      - Telegram ID пользователя
 * E: username         - Username пользователя
 * F: iiko_document_id - ID документа в iiko (только для Склада)
 * G: iiko_doc_number  - Номер документа в iiko
 * H: status           - Статус: NEW, IIKO_OK, IIKO_ERROR, SENT
 * I: error_message    - Сообщение об ошибке
 * J: raw_text         - Сводный текст позиций
 */
class GoogleSheetsService {
  constructor(serviceAccountJson, spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheetName = 'Transfer Logs';

    this.auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  /**
   * Инициализация листа с заголовками
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

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!A1:J1`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              'Timestamp',
              'Role',
              'Items (JSON)',
              'Telegram ID',
              'Username',
              'iiko Document ID',
              'iiko Doc Number',
              'Status',
              'Error Message',
              'Raw Text'
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
   * Добавить запись о перемещении
   * @returns {Promise<number>} - Индекс добавленной строки
   */
  async appendTransferRow(payload) {
    const {
      role,
      items,
      telegramId,
      username,
      rawText
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
      role || '',                             // B: role
      JSON.stringify(items),                  // C: items_json
      String(telegramId),                     // D: telegram_id
      username || '',                         // E: username
      '',                                     // F: iiko_document_id
      '',                                     // G: iiko_doc_number
      'NEW',                                  // H: status
      '',                                     // I: error_message
      rawText || ''                           // J: raw_text
    ];

    try {
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });

      const updatedRange = response.data.updates.updatedRange;
      const match = updatedRange.match(/!A(\d+):/);
      const rowIndex = match ? parseInt(match[1]) : null;

      console.log(`Transfer logged at row ${rowIndex}`);

      return rowIndex;
    } catch (error) {
      console.error('Error appending transfer row:', error.message);
      throw error;
    }
  }

  /**
   * Обновить статус записи перемещения
   */
  async updateTransferRow(rowIndex, updates) {
    const { iikoDocumentId, iikoDocumentNumber, status, errorMessage } = updates;

    try {
      const data = [];

      if (iikoDocumentId !== undefined) {
        data.push({
          range: `${this.sheetName}!F${rowIndex}`,
          values: [[iikoDocumentId || '']]
        });
      }

      if (iikoDocumentNumber !== undefined) {
        data.push({
          range: `${this.sheetName}!G${rowIndex}`,
          values: [[iikoDocumentNumber || '']]
        });
      }

      if (status !== undefined) {
        data.push({
          range: `${this.sheetName}!H${rowIndex}`,
          values: [[status]]
        });
      }

      if (errorMessage !== undefined) {
        data.push({
          range: `${this.sheetName}!I${rowIndex}`,
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

        console.log(`Transfer row ${rowIndex} updated: status=${status}`);
      }
    } catch (error) {
      console.error('Error updating transfer row:', error.message);
      throw error;
    }
  }

  /**
   * Получить последние перемещения пользователя
   */
  async getRecentTransfers(telegramId, limit = 5) {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A2:J1000`,
        valueRenderOption: 'FORMATTED_VALUE'
      });

      const rows = response.data.values || [];
      const telegramIdStr = String(telegramId);

      // Фильтруем по telegram_id (колонка D, индекс 3)
      const userRows = rows
        .filter(row => row[3] === telegramIdStr)
        .slice(-limit)
        .reverse();

      return userRows.map(row => ({
        timestamp: row[0],          // A
        role: row[1],               // B
        itemsJson: row[2],          // C
        iikoDocumentId: row[5],     // F
        iikoDocNumber: row[6],      // G
        status: row[7],             // H
        errorMessage: row[8],       // I
        rawText: row[9]             // J
      }));
    } catch (error) {
      console.error('Error getting recent transfers:', error.message);
      return [];
    }
  }

  /**
   * Получить все перемещения за сегодня
   */
  async getTodayTransfers() {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A2:J10000`,
        valueRenderOption: 'FORMATTED_VALUE'
      });

      const rows = response.data.values || [];

      const today = new Date().toLocaleDateString('ru-RU', {
        timeZone: 'Asia/Novosibirsk',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      const todayRows = rows.filter(row => {
        const timestamp = row[0] || '';
        return timestamp.startsWith(today);
      });

      const stats = {
        total: todayRows.length,
        success: 0,
        errors: 0,
        pending: 0,
        byRole: { 'Кухня': 0, 'Склад': 0 },
        items: []
      };

      for (const row of todayRows) {
        const role = row[1] || 'Неизвестно';
        const status = row[7] || 'NEW';
        const rawText = row[9] || '';
        const docNumber = row[6] || '';

        if (status === 'IIKO_OK' || status === 'SENT') stats.success++;
        else if (status === 'IIKO_ERROR') stats.errors++;
        else stats.pending++;

        if (stats.byRole[role] !== undefined) {
          stats.byRole[role]++;
        }

        stats.items.push({
          timestamp: row[0],
          role,
          rawText,
          status,
          docNumber
        });
      }

      return stats;
    } catch (error) {
      console.error('Error getting today transfers:', error.message);
      return { total: 0, success: 0, errors: 0, pending: 0, byRole: { 'Кухня': 0, 'Склад': 0 }, items: [] };
    }
  }
}

module.exports = GoogleSheetsService;
