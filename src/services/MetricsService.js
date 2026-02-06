// Импортируем ProxyService для получения статуса Circuit Breaker
// Используем поздний импорт для избежания циклической зависимости
let proxyServiceRef = null;

export function setProxyServiceRef(ref) {
  proxyServiceRef = ref;
}

function getCircuitBreakerStats() {
  if (!proxyServiceRef) {
    return { state: 'UNKNOWN', failureCount: 0, nextAttemptTime: 0 };
  }
  try {
    return proxyServiceRef.getCircuitBreakerStatus();
  } catch (e) {
    return { state: 'UNKNOWN', failureCount: 0, nextAttemptTime: 0 };
  }
}

/**
 * Сервис для сбора метрик и трассировки запросов
 * Хранит последние запросы в памяти и предоставляет статистику
 */

class RequestStore {
  constructor(maxSize = 1000) {
    this.store = [];
    this.maxSize = maxSize;
    this.index = new Map(); // Для быстрого поиска по ID
    this.nextId = 1;
  }

  add(request) {
    const id = String(this.nextId++);
    const entry = { ...request, id, timestamp: new Date().toISOString() };
    
    // Добавление в начало массива (новые первыми)
    this.store.unshift(entry);
    this.index.set(id, entry);
    
    // Удаление старых записей если превышен лимит
    while (this.store.length > this.maxSize) {
      const removed = this.store.pop();
      if (removed) {
        this.index.delete(removed.id);
      }
    }
    
    return id;
  }

  get(id) {
    return this.index.get(id);
  }

  getAll(limit = 50) {
    return this.store.slice(0, limit);
  }

  getFiltered(filter, limit = 50) {
    let result = this.store;
    
    if (filter.status) {
      result = result.filter(r => r.status === filter.status);
    }
    
    if (filter.method) {
      result = result.filter(r => r.method === filter.method);
    }
    
    if (filter.minDuration !== undefined) {
      result = result.filter(r => r.durationMs >= filter.minDuration);
    }
    
    if (filter.model) {
      result = result.filter(r => r.model === filter.model);
    }
    
    if (filter.stream !== undefined) {
      result = result.filter(r => r.stream === filter.stream);
    }
    
    return result.slice(0, limit);
  }

  clear() {
    this.store = [];
    this.index.clear();
    this.nextId = 1;
  }

  getStats() {
    const total = this.store.length;
    const byStatus = {};
    const byModel = {};
    let totalDuration = 0;
    
    this.store.forEach(req => {
      // Счётчик по статусам
      byStatus[req.status] = (byStatus[req.status] || 0) + 1;
      
      // Счётчик по моделям
      if (req.model) {
        byModel[req.model] = (byModel[req.model] || 0) + 1;
      }
      
      // Общая длительность
      totalDuration += req.durationMs || 0;
    });

    return {
      total,
      byStatus,
      byModel,
      averageDuration: total > 0 ? Math.round(totalDuration / total) : 0,
    };
  }
}

export class MetricsService {
  constructor() {
    this.requestStore = new RequestStore(1000);
    
    // Счётчики для агрегации
    this.counters = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      timeoutRequests: 0,
      circuitBreakerBlocked: 0,
    };
    
    // Статистика по времени
    this.startTime = Date.now();
    this.lastActiveTime = Date.now();
  }

  /**
   * Регистрирует начало запроса
   * @param {string} method - HTTP метод
   * @param {string} url - URL
   * @param {object} headers - Заголовки запроса
   * @param {object} body - Тело запроса
   * @returns {string} ID запроса
   */
  startRequest(method, url, headers, body) {
    return this.requestStore.add({
      method,
      url,
      headers: this.sanitizeHeaders(headers),
      body: this.sanitizeBody(body),
      model: body?.model || null,
      stream: body?.stream || false,
      status: 'pending',
      durationMs: null,
      upstreamStatus: null,
      errorMessage: null,
      responsePreview: null,
    });
  }

  /**
   * Завершает запрос с успешным результатом
   * @param {string} requestId - ID запроса
   * @param {number} upstreamStatus - Статус ответа от upstream
   * @param {object} responseBody - Тело ответа
   * @param {number} durationMs - Длительность выполнения
   */
  finishRequestSuccess(requestId, upstreamStatus, responseBody, durationMs) {
    const request = this.requestStore.get(requestId);
    if (request) {
      request.status = upstreamStatus >= 400 ? 'error' : 'success';
      request.upstreamStatus = upstreamStatus;
      request.durationMs = durationMs;
      request.responsePreview = this.sanitizeResponse(responseBody);
    }
    
    this.counters.totalRequests++;
    this.counters.successfulRequests++;
    this.lastActiveTime = Date.now();
  }

  /**
   * Завершает запрос с ошибкой
   * @param {string} requestId - ID запроса
   * @param {string|Error} error - Ошибка
   * @param {number} durationMs - Длительность до ошибки
   * @param {string} errorType - Тип ошибки
   */
  finishRequestError(requestId, error, durationMs, errorType) {
    const request = this.requestStore.get(requestId);
    if (request) {
      request.status = 'error';
      request.durationMs = durationMs;
      request.errorMessage = error.message || String(error);
      request.errorType = errorType;
    }
    
    this.counters.totalRequests++;
    this.counters.failedRequests++;
    
    if (errorType === 'timeout') {
      this.counters.timeoutRequests++;
    } else if (errorType === 'circuit_breaker') {
      this.counters.circuitBreakerBlocked++;
    }
    
    this.lastActiveTime = Date.now();
  }

  /**
   * Очистка чувствительных данных из заголовков
   */
  sanitizeHeaders(headers) {
    const sensitive = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
    const sanitized = {};
    
    for (const [key, value] of Object.entries(headers || {})) {
      if (sensitive.includes(key.toLowerCase())) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Очистка чувствительных данных из тела запроса
   */
  sanitizeBody(body) {
    if (!body) return null;
    
    const sanitized = { ...body };
    
    // Санитайзинг API ключей
    if (sanitized.api_key) {
      sanitized.api_key = '***REDACTED***';
    }
    
    // Санитайзинг сообщений (оставляем только роль и длину контента)
    if (sanitized.messages) {
      sanitized.messages = sanitized.messages.map(msg => ({
        role: msg.role,
        contentLength: typeof msg.content === 'string' ? msg.content.length : 'N/A',
      }));
    }
    
    return sanitized;
  }

  /**
   * Подготовка ответа для отображения в дашборде
   * Сохраняет полный контент thoughts и response для красивого отображения в дашборде
   */
  sanitizeResponse(response) {
    if (!response) return null;
    
    // Если это объект с ошибкой
    if (response.error) {
      return {
        error: response.error,
        response: null,
        thoughts: null,
        hasThoughts: false,
        responsePreview: '',
        thoughtsPreview: '',
        finishReason: 'error',
      };
    }
    
    // Проверяем: это streaming ответ (из ProxyService) или обычный JSON
    const isStreamResponse = typeof response === 'object' && ('thoughts' in response || 'response' in response);
    
    if (isStreamResponse) {
      // Streaming ответ (накопленный в ProxyService)
      const thoughts = response.thoughts || response.reasoning || null;
      const resp = response.response || response.content || '';
      
      return {
        response: resp,
        thoughts: thoughts,
        hasThoughts: !!thoughts && thoughts.length > 0,
        responsePreview: this.createPreview(resp, 100),
        thoughtsPreview: thoughts ? this.createPreview(thoughts, 80) : '',
        finishReason: response.finishReason || 'stream_complete',
      };
    }
    
    // Обычный JSON ответ от OpenAI (non-streaming)
    const content = response.choices?.[0]?.message?.content || '';
    
    // Поддержка разных форматов reasoning_content
    const reasoning = response.choices?.[0]?.message?.reasoning_content ||
                      response.choices?.[0]?.message?.reasoning ||
                      response.choices?.[0]?.delta?.reasoning_content ||
                      null;
    
    return {
      response: content,
      thoughts: reasoning,
      hasThoughts: !!reasoning && reasoning.length > 0,
      responsePreview: this.createPreview(content, 100),
      thoughtsPreview: reasoning ? this.createPreview(reasoning, 80) : '',
      finishReason: response.choices?.[0]?.finish_reason || null,
    };
  }

  /**
   * Создаёт превью текста с обрезкой
   * @param {string} text - исходный текст
   * @param {number} maxLength - максимальная длина
   * @returns {string} - превью с '...' если обрезано
   */
  createPreview(text, maxLength) {
    if (!text || typeof text !== 'string') return '';
    const cleaned = text.replace(/\n/g, ' ').trim();
    return cleaned.length > maxLength
      ? cleaned.slice(0, maxLength) + '...'
      : cleaned;
  }

  /**
   * Получить последние запросы
   */
  getRecentRequests(limit = 50, filter = {}) {
    return this.requestStore.getFiltered(filter, limit);
  }

  /**
   * Получить конкретный запрос по ID
   */
  getRequest(id) {
    const request = this.requestStore.get(id);
    if (!request) return null;
    
    // Для детального просмотра возвращаем расширенные данные
    return {
      ...request,
      fullBody: request.body, // В детальном виде показываем больше
    };
  }

  /**
   * Получить статистику
   */
  getStats() {
    const uptime = Date.now() - this.startTime;
    const idleTime = Date.now() - this.lastActiveTime;
    
    return {
      uptime,
      uptimeFormatted: this.formatDuration(uptime),
      idleTime,
      uptimeDays: Math.floor(uptime / (1000 * 60 * 60 * 24)),
      counters: { ...this.counters },
      requestStore: this.requestStore.getStats(),
      circuitBreaker: getCircuitBreakerStats(),
    };
  }

  /**
   * Получить статистику Circuit Breaker
   */
  getCircuitBreakerStats() {
    return getCircuitBreakerStats();
  }

  /**
   * Форматирование длительности
   */
  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Сброс счётчиков
   */
  resetCounters() {
    this.counters = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      timeoutRequests: 0,
      circuitBreakerBlocked: 0,
    };
  }

  /**
   * Очистка всех данных
   */
  clearAll() {
    this.requestStore.clear();
    this.resetCounters();
    this.startTime = Date.now();
  }
}

// Экспорт синглтона
export const metricsService = new MetricsService();
