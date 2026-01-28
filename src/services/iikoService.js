const axios = require('axios');

/**
 * Сервис для работы с iiko Server API (REST API v2)
 * Документация: https://ru.iiko.help/articles/api-documentations/akty-spisaniya
 */
class IikoService {
  constructor(config) {
    // iiko Server API
    this.baseUrl = config.baseUrl; // https://shaurma-dzerzhinskogo-2-2.iiko.it:443/resto
    this.login = config.login;
    this.password = config.password;

    // Сессионный ключ
    this.sessionKey = null;
    this.sessionCreatedAt = null;
    this.SESSION_LIFETIME = 900000; // 15 минут (iiko сессия живет ~15 мин)
  }

  /**
   * Авторизация в iiko Server API
   * GET /resto/api/auth?login={login}&pass={pass}
   */
  async authenticate() {
    try {
      console.log('Authenticating with iiko Server API...');

      const response = await axios.get(
        `${this.baseUrl}/api/auth`,
        {
          params: {
            login: this.login,
            pass: this.password
          },
          timeout: 10000
        }
      );

      // Ответ - просто ключ сессии в виде строки
      this.sessionKey = response.data;
      this.sessionCreatedAt = Date.now();

      console.log('iiko session key received');

      return this.sessionKey;
    } catch (error) {
      console.error('Error authenticating with iiko:', error.message);

      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }

      throw new Error(`iiko auth failed: ${error.message}`);
    }
  }

  /**
   * Завершить сессию (logout)
   */
  async logout() {
    if (!this.sessionKey) return;

    try {
      await axios.get(`${this.baseUrl}/api/logout`, {
        params: { key: this.sessionKey },
        timeout: 5000
      });
      console.log('iiko session closed');
    } catch (error) {
      console.error('Error closing iiko session:', error.message);
    } finally {
      this.sessionKey = null;
      this.sessionCreatedAt = null;
    }
  }

  /**
   * Проверить и обновить сессию при необходимости
   */
  async ensureValidSession() {
    const now = Date.now();

    if (
      !this.sessionKey ||
      !this.sessionCreatedAt ||
      (now - this.sessionCreatedAt) > this.SESSION_LIFETIME
    ) {
      await this.authenticate();
    }

    return this.sessionKey;
  }

  /**
   * Выполнить HTTP запрос к iiko Server API
   */
  async makeRequest(endpoint, method = 'GET', body = null, params = {}, retryCount = 0) {
    const maxRetries = 2;

    try {
      const key = await this.ensureValidSession();

      const config = {
        method,
        url: `${this.baseUrl}/api/v2/${endpoint}`,
        params: { ...params, key },
        timeout: 15000
      };

      if (body && (method === 'POST' || method === 'PUT')) {
        config.headers = { 'Content-Type': 'application/json' };
        config.data = body;
      }

      const response = await axios(config);

      return response.data;
    } catch (error) {
      const status = error.response?.status;

      // 401/403 - сессия истекла
      if ((status === 401 || status === 403) && retryCount < maxRetries) {
        console.log('Session expired, re-authenticating...');
        this.sessionKey = null;
        await this.authenticate();

        return this.makeRequest(endpoint, method, body, params, retryCount + 1);
      }

      console.error(`iiko API error (${endpoint}):`, error.message);

      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }

      throw error;
    }
  }

  // ============ СПРАВОЧНИКИ ============

  /**
   * Получить список складов
   * GET /resto/api/corporation/stores
   */
  async getStores() {
    try {
      const key = await this.ensureValidSession();

      const response = await axios.get(
        `${this.baseUrl}/api/corporation/stores`,
        {
          params: { key },
          timeout: 15000
        }
      );

      // Ответ - XML или JSON в зависимости от версии
      // Парсим массив складов
      const stores = response.data?.corporateItemDto || response.data || [];

      return Array.isArray(stores) ? stores : [stores];
    } catch (error) {
      console.error('Error getting stores:', error.message);
      throw error;
    }
  }

  /**
   * Получить список расходных счетов (для актов списания)
   * GET /resto/api/v2/entities/products/list - с фильтром по типу account
   * или /resto/api/account/getAccountingCategories
   */
  async getExpenseAccounts() {
    try {
      const key = await this.ensureValidSession();

      // Пробуем получить счета через v2 API
      try {
        const response = await axios.get(
          `${this.baseUrl}/api/v2/entities/list`,
          {
            params: { key, rootType: 'Account' },
            timeout: 15000
          }
        );

        const accounts = response.data || [];
        return Array.isArray(accounts) ? accounts : [accounts];
      } catch (e1) {
        // Если не работает, пробуем другой эндпоинт
        console.log('Trying alternative endpoint for accounts...');

        const response = await axios.get(
          `${this.baseUrl}/api/account/getAccountingCategories`,
          {
            params: { key },
            timeout: 15000
          }
        );

        const accounts = response.data?.accountingCategoryDto || response.data || [];
        return Array.isArray(accounts) ? accounts : [accounts];
      }
    } catch (error) {
      console.error('Error getting expense accounts:', error.message);
      // Возвращаем пустой массив вместо ошибки - счета опциональны
      return [];
    }
  }

  /**
   * Получить номенклатуру (товары)
   * GET /resto/api/products
   */
  async getProducts() {
    try {
      const key = await this.ensureValidSession();

      const response = await axios.get(
        `${this.baseUrl}/api/products`,
        {
          params: { key },
          timeout: 30000
        }
      );

      const products = response.data?.productDto || response.data || [];

      return Array.isArray(products) ? products : [products];
    } catch (error) {
      console.error('Error getting products:', error.message);
      throw error;
    }
  }

  /**
   * Поиск товара по названию
   */
  async findProductByName(name) {
    try {
      const products = await this.getProducts();
      const searchName = name.toLowerCase().trim();

      // Ищем точное совпадение или частичное
      return products.find(p =>
        p.name?.toLowerCase() === searchName ||
        p.name?.toLowerCase().includes(searchName)
      );
    } catch (error) {
      console.error('Error finding product:', error.message);
      return null;
    }
  }

  // ============ АКТЫ СПИСАНИЯ ============

  /**
   * Получить список актов списания за период
   * GET /resto/api/v2/documents/writeoff
   *
   * @param {string} dateFrom - Начало периода (yyyy-MM-dd)
   * @param {string} dateTo - Конец периода (yyyy-MM-dd)
   * @param {string} status - Статус документа (опционально)
   */
  async getWriteoffDocuments(dateFrom, dateTo, status = null) {
    try {
      const params = { dateFrom, dateTo };
      if (status) params.status = status;

      const response = await this.makeRequest('documents/writeoff', 'GET', null, params);

      return response || [];
    } catch (error) {
      console.error('Error getting writeoff documents:', error.message);
      throw error;
    }
  }

  /**
   * Получить акт списания по ID
   * GET /resto/api/v2/documents/writeoff/byId
   */
  async getWriteoffById(id) {
    try {
      const response = await this.makeRequest('documents/writeoff/byId', 'GET', null, { id });

      return response;
    } catch (error) {
      console.error('Error getting writeoff by id:', error.message);
      throw error;
    }
  }

  /**
   * Создать акт списания
   * POST /resto/api/v2/documents/writeoff
   *
   * @param {Object} params - Параметры документа
   * @param {string} params.storeId - UUID склада (обязательно)
   * @param {string} params.accountId - UUID расходного счета (обязательно)
   * @param {Array} params.items - Позиции [{ productId, amount }] (обязательно)
   * @param {string} params.comment - Комментарий
   * @param {string} params.documentNumber - Номер документа (авто если не указан)
   */
  async createWriteoffDocument({ storeId, accountId, items, comment = '', documentNumber = null }) {
    try {
      console.log('Creating writeoff document...');
      console.log('Store:', storeId);
      console.log('Account:', accountId);
      console.log('Items:', JSON.stringify(items, null, 2));

      // Формируем дату в формате iiko
      const now = new Date();
      const dateIncoming = now.toISOString().slice(0, 16); // "yyyy-MM-ddTHH:mm"

      const documentBody = {
        dateIncoming,
        status: 'NEW',
        storeId,
        accountId,
        comment: comment || `Списание от ${now.toLocaleDateString('ru-RU')}`,
        items: items.map((item, index) => ({
          productId: item.productId,
          amount: item.amount
        }))
      };

      if (documentNumber) {
        documentBody.documentNumber = documentNumber;
      }

      console.log('Request body:', JSON.stringify(documentBody, null, 2));

      const response = await this.makeRequest('documents/writeoff', 'POST', documentBody);

      console.log('Writeoff created:', JSON.stringify(response, null, 2));

      return {
        success: response.result === 'SUCCESS',
        documentId: response.response?.id,
        documentNumber: response.response?.documentNumber,
        errors: response.errors || [],
        response: response.response
      };
    } catch (error) {
      console.error('Error creating writeoff document:', error.message);

      return {
        success: false,
        documentId: null,
        error: error.message
      };
    }
  }

  /**
   * Провести акт списания (изменить статус на PROCESSED)
   */
  async processWriteoffDocument(documentId) {
    try {
      // Получаем текущий документ
      const doc = await this.getWriteoffById(documentId);

      if (!doc) {
        throw new Error('Document not found');
      }

      // Обновляем статус
      const documentBody = {
        ...doc,
        id: documentId,
        status: 'PROCESSED'
      };

      const response = await this.makeRequest('documents/writeoff', 'POST', documentBody);

      return {
        success: response.result === 'SUCCESS',
        errors: response.errors || []
      };
    } catch (error) {
      console.error('Error processing writeoff document:', error.message);

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Парсинг текста с позициями для списания
   * Формат: "помидор 5 кг; огурец 3 кг; курица филе 10 кг"
   *
   * @param {string} text - Текст от пользователя
   * @returns {Array} - Массив распарсенных позиций
   */
  parseWriteoffItems(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const items = [];

    // Разделяем по ; или переносу строки
    const parts = text.split(/[;\n]+/).map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
      // Ищем число и единицу измерения в конце строки
      // Примеры: "помидор 5 кг", "курица филе 10.5 kg", "масло 2л"
      const match = part.match(/^(.+?)\s+([\d.,]+)\s*(кг|kg|г|g|л|l|шт|pcs)?$/i);

      if (match) {
        const name = match[1].trim();
        const amount = parseFloat(match[2].replace(',', '.'));
        let unit = (match[3] || 'кг').toLowerCase();

        // Нормализуем единицы
        const unitMap = {
          'kg': 'кг',
          'g': 'г',
          'l': 'л',
          'pcs': 'шт'
        };
        unit = unitMap[unit] || unit;

        if (name && !isNaN(amount) && amount > 0) {
          items.push({
            name,
            amount,
            unit,
            // productId будет заполняться при сопоставлении с номенклатурой iiko
            productId: null
          });
        }
      } else {
        // Если не удалось распарсить, добавляем как есть для ручной обработки
        items.push({
          name: part,
          amount: 0,
          unit: 'кг',
          productId: null,
          parseError: true
        });
      }
    }

    return items;
  }
}

module.exports = IikoService;
