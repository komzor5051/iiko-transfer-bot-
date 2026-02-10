const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// XML парсер для ответов iiko API
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Сервис для работы с iiko Server API (REST API v2)
 */
class IikoService {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.login = config.login;
    this.password = config.password;

    this.sessionKey = null;
    this.sessionCreatedAt = null;
    this.SESSION_LIFETIME = 900000; // 15 минут
  }

  /**
   * Авторизация в iiko Server API
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
   */
  async getStores() {
    try {
      const key = await this.ensureValidSession();

      const response = await axios.get(
        `${this.baseUrl}/api/corporation/stores`,
        {
          params: { key },
          headers: { 'Accept': 'application/xml' },
          timeout: 15000
        }
      );

      const parsed = xmlParser.parse(response.data);
      const stores = parsed?.corporateItemDtoes?.corporateItemDto || [];

      return Array.isArray(stores) ? stores : [stores];
    } catch (error) {
      console.error('Error getting stores:', error.message);
      throw error;
    }
  }

  /**
   * Получить номенклатуру (товары)
   */
  async getProducts() {
    try {
      const key = await this.ensureValidSession();

      const response = await axios.get(
        `${this.baseUrl}/api/products`,
        {
          params: { key },
          headers: { 'Accept': 'application/xml' },
          timeout: 30000
        }
      );

      const parsed = xmlParser.parse(response.data);
      const products = parsed?.productDtoes?.productDto || [];

      return Array.isArray(products) ? products : [products];
    } catch (error) {
      console.error('Error getting products:', error.message);
      throw error;
    }
  }

  // ============ ПЕРЕМЕЩЕНИЯ ============

  /**
   * Создать документ перемещения (internal transfer)
   * POST /resto/api/v2/documents/internalTransfer
   *
   * @param {Object} params
   * @param {string} params.storeFrom - UUID склада-источника
   * @param {string} params.storeTo - UUID склада-получателя
   * @param {Array} params.items - Позиции [{ productId, amount }]
   * @param {string} params.comment - Комментарий
   */
  async createTransferDocument({ storeFrom, storeTo, items, comment = '' }) {
    try {
      console.log('Creating transfer document...');
      console.log('Store from:', storeFrom);
      console.log('Store to:', storeTo);
      console.log('Items:', JSON.stringify(items, null, 2));

      const now = new Date();
      const dateIncoming = now.toISOString().slice(0, 16);

      const documentBody = {
        dateIncoming,
        status: 'NEW',
        storeFromId: storeFrom,
        storeToId: storeTo,
        comment: comment || `Перемещение от ${now.toLocaleDateString('ru-RU')}`,
        items: items.map(item => ({
          productId: item.productId,
          amount: item.amount
        }))
      };

      console.log('Request body:', JSON.stringify(documentBody, null, 2));

      const response = await this.makeRequest('documents/internalTransfer', 'POST', documentBody);

      console.log('Transfer created:', JSON.stringify(response, null, 2));

      return {
        success: response.result === 'SUCCESS',
        documentId: response.response?.id,
        documentNumber: response.response?.documentNumber,
        errors: response.errors || [],
        response: response.response
      };
    } catch (error) {
      console.error('Error creating transfer document:', error.message);

      return {
        success: false,
        documentId: null,
        error: error.message
      };
    }
  }
}

module.exports = IikoService;
