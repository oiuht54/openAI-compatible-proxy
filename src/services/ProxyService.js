// @ts-check
import axios from 'axios';
import http from 'http';
import https from 'https';
import { PassThrough, Transform } from 'stream';
import { LoggerService } from '../utils/Logger.js';
import { configManager } from '../config/ConfigManager.js';
import { metricsService } from './MetricsService.js';

/**
 * HeartbeatStream - поток для поддержания SSE соединения активным
 * Отправляет heartbeat сообщения если между токенами проходит слишком много времени
 */
class HeartbeatStream extends Transform {
  /**
   * @param {Object} options
   * @param {number} options.intervalMs - интервал heartbeat в миллисекундах
   * @param {string} options.heartbeatMessage - сообщение heartbeat (SSE комментарий)
   */
  constructor({ intervalMs, heartbeatMessage }) {
    super({ decodeStrings: false });
    this.intervalMs = intervalMs;
    this.heartbeatMessage = heartbeatMessage;
    this.lastActivityTime = Date.now();
    /** @type {NodeJS.Timeout|null} */
    this.heartbeatTimer = null;
    this.ended = false;
    
    this.startHeartbeat();
  }

  /**
   * @param {Buffer} chunk
   * @param {BufferEncoding} encoding
   * @param {(error?: Error | null) => void} callback
   */
  _transform(chunk, encoding, callback) {
    this.lastActivityTime = Date.now();
    this.push(chunk, encoding);
    callback();
  }

  /**
   * @param {(error?: Error | null) => void} callback
   */
  _flush(callback) {
    this.stopHeartbeat();
    callback();
  }

  startHeartbeat() {
    const sendHeartbeat = () => {
      if (this.ended) return;
      
      const now = Date.now();
      const timeSinceActivity = now - this.lastActivityTime;
      
      if (timeSinceActivity >= this.intervalMs) {
        this.push(this.heartbeatMessage + '\n');
        LoggerService.debug(`Heartbeat sent (${timeSinceActivity}ms since last data)`);
      }
      
      this.heartbeatTimer = setTimeout(sendHeartbeat, this.intervalMs);
    };
    
    this.heartbeatTimer = setTimeout(sendHeartbeat, this.intervalMs);
    
    // Обеспечиваем очистку таймера при сборке мусора
    this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    this.ended = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * Circuit Breaker для защиты от cascading failures
 */
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.failureThreshold = threshold;
    this.timeout = timeout;
    this.lastAttemptTime = Date.now();
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttemptTime = 0;
  }

  /**
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async execute(fn) {
    if (this.state === 'OPEN' && Date.now() < this.nextAttemptTime) {
      throw new Error('Circuit Breaker is OPEN requests are temporarily blocked');
    }

    if (this.state === 'OPEN' && Date.now() >= this.nextAttemptTime) {
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.timeout;
      LoggerService.warn(`Circuit Breaker OPENED. ${this.failureCount} failures. Next attempt in ${this.timeout}ms`);
    }
  }

  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttemptTime: this.state === 'OPEN' ? this.nextAttemptTime - Date.now() : 0,
    };
  }
}

// Глобальный circuit breaker для upstream
const circuitBreaker = new CircuitBreaker(5, 60000);

/**
 * Утилита для retry запросов с экспоненциальным backoff
 * @param {() => Promise<any>} fn
 * @param {number} maxRetries
 * @param {number} baseDelay
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Не retry для клиентских ошибок (4xx) и некоторых специфических ошибок
      const err = /** @type {any} */ (error);
      if (err.response && typeof err.response.status === 'number' && 
          err.response.status >= 400 && err.response.status < 500) {
        throw error;
      }
      
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        LoggerService.warn(`Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms...`, {
          error: err.message,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Специализированная ошибка для таймаута первого токена
 */
export class FirstTokenTimeoutError extends Error {
  constructor(message = 'First token timeout', retryCount = 0) {
    super(message);
    this.name = 'FirstTokenTimeoutError';
    this.retryCount = retryCount;
  }
}

/**
 * Фильтрация чувствительных заголовков для логирования
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function filterSensitiveHeaders(headers) {
  const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
  const filtered = /** @type {Record<string, string>} */ ({});
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveHeaders.includes(lowerKey)) {
      filtered[key] = '[REDACTED]';
    } else {
      filtered[key] = value;
    }
  }
  
  return filtered;
}

export class ProxyService {
  /** @type {Map<AbortController, () => void>} */
  static activeControllers = new Map();

  static cancelAllRequests() {
    LoggerService.warn(`Force killing ${this.activeControllers.size} active requests...`);
    for (const [controller] of this.activeControllers) {
      controller.abort('Server Shutdown');
    }
    this.activeControllers.clear();
  }

  static getCircuitBreakerStatus() {
    return circuitBreaker.getStatus();
  }

  static getCircuitBreaker() {
    return circuitBreaker;
  }

  constructor() {
    this.client = axios.create({
      timeout: 0,
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: 30000,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: 30000,
        rejectUnauthorized: true,
      }),
      validateStatus: () => true,
    });
  }

  /**
   * Execute streaming request with first-token timeout and transparent retry
   * @param {Object} params
   * @param {string} params.method
   * @param {string} params.targetUrl
   * @param {Record<string, string>} params.forwardHeaders
   * @param {any} params.body
   * @param {AbortController} params.abortController
   * @param {number} params.firstTokenTimeoutMs
   * @param {number} params.firstTokenRetryAttempts
   * @param {string} params.requestId
   * @returns {Promise<import('axios').AxiosResponse>}
   */
  async executeStreamingWithFirstTokenRetry({
    method,
    targetUrl,
    forwardHeaders,
    body,
    abortController,
    firstTokenTimeoutMs,
    firstTokenRetryAttempts,
    requestId,
  }) {
    /** @type {Error|null} */
    let lastError;

    for (let attempt = 0; attempt <= firstTokenRetryAttempts; attempt++) {
      const attemptController = attempt === 0 ? abortController : new AbortController();
      let firstTokenReceived = false;
      /** @type {NodeJS.Timeout|null} */
      let firstTokenTimeoutId = null;

      try {
        const response = await circuitBreaker.execute(async () => {
          return await this.client({
            method: method,
            url: targetUrl,
            headers: forwardHeaders,
            data: body,
            responseType: 'stream',
            signal: attemptController.signal,
          });
        });

        if (!response.data || typeof response.data.pipe !== 'function') {
          return response;
        }

        const firstTokenPromise = new Promise((resolve, reject) => {
          firstTokenTimeoutId = setTimeout(() => {
            if (!firstTokenReceived) {
              attemptController.abort('First Token Timeout');
              reject(new FirstTokenTimeoutError(`No tokens received within ${firstTokenTimeoutMs}ms`, attempt));
            }
          }, firstTokenTimeoutMs);

          const checkForFirstToken = (/** @type {Buffer} */ chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
              if (line.trim().startsWith('data: ')) {
                const jsonStr = line.trim().substring(6);
                if (jsonStr === '[DONE]') continue;
                try {
                  const data = JSON.parse(jsonStr);
                  const delta = data.choices?.[0]?.delta;
                  if (delta && (delta.content || delta.reasoning_content || delta.reasoning)) {
                    firstTokenReceived = true;
                    if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
                    resolve(null);
                    return;
                  }
                } catch (e) {
                }
              }
            }
          };

          response.data.on('data', checkForFirstToken);
          response.data.once('end', () => {
            if (!firstTokenReceived && firstTokenTimeoutId) {
              clearTimeout(firstTokenTimeoutId);
            }
          });
          response.data.once('error', () => {
            if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
          });
        });

        await firstTokenPromise;
        return response;

      } catch (error) {
        if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);

        if (error instanceof FirstTokenTimeoutError) {
          LoggerService.warn(`First token timeout (attempt ${attempt + 1}/${firstTokenRetryAttempts + 1}). Retrying...`);
          lastError = error;
          metricsService.finishRequestError(requestId, error, 0, 'first_token_timeout');
          
          if (attempt < firstTokenRetryAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new FirstTokenTimeoutError('First token timeout after all retries');
  }

  /**
   * @param {string} endpoint
   * @param {string} method
   * @param {Record<string, string>} headers
   * @param {any} body
   * @param {import('express').Response} res
   */
  async forwardRequest(endpoint, method, headers, body, res) {
    const currentConfig = configManager.get();
    const upstreamConfig = currentConfig.upstream;
    const currentTimeoutMs = upstreamConfig.timeoutMs;

    const abortController = new AbortController();
    let cleanedUp = false;
    
    // Флаги для отслеживания активных обработчиков
    /** @type {Array<{emitter: import('events').EventEmitter, event: string, handler: (...args: any[]) => void}>} */
    const eventHandlers = [];

    // Функция для безопасной очистки ресурсов
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      
      clearTimeout(timeoutId);
      ProxyService.activeControllers.delete(abortController);
      
      // Удаляем все зарегистрированные обработчики событий
      eventHandlers.forEach(({ emitter, event, handler }) => {
        emitter.off(event, handler);
      });
      eventHandlers.length = 0;
    };

    /**
     * @param {import('events').EventEmitter} emitter
     * @param {string} event
     * @param {(...args: any[]) => void} handler
     */
    const registerHandler = (emitter, event, handler) => {
      eventHandlers.push({ emitter, event, handler });
      emitter.on(event, handler);
    };

    ProxyService.activeControllers.set(abortController, cleanup);

    const timeoutId = setTimeout(() => {
      LoggerService.warn(`Request timed out after ${currentTimeoutMs}ms. Aborting...`);
      abortController.abort('Request Timeout');
      cleanup();
    }, currentTimeoutMs);

    const baseUrl = upstreamConfig.url.replace(/\/$/, "");
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const targetUrl = `${baseUrl}${cleanEndpoint}`;
    
    const forwardHeaders = { ...headers };
    
    // Удаляем заголовки которые нужно фильтровать
    delete forwardHeaders['host'];
    delete forwardHeaders['content-length'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['accept-encoding']; 
    
    if (upstreamConfig.apiKey) {
      forwardHeaders['authorization'] = `Bearer ${upstreamConfig.apiKey}`;
    }

    // Логируем с фильтрованными заголовками
    LoggerService.logTraffic('req', `${method} ${targetUrl}`, {
      headers: filterSensitiveHeaders(forwardHeaders),
      body: body,
    });

    const isStreaming = body?.stream === true;
    const requestStartTime = Date.now();
    const firstTokenTimeoutMs = upstreamConfig.firstTokenTimeoutMs || 20000;
    const firstTokenRetryAttempts = upstreamConfig.firstTokenRetryAttempts || 2;

    // Регистрация начала запроса в метриках
    const requestId = metricsService.startRequest(method, targetUrl, forwardHeaders, body);

    try {
      // Выполняем запрос через circuit breaker и с retry
      // Для стриминговых запросов используем специальную логику с first-token timeout
      const response = isStreaming
        ? await this.executeStreamingWithFirstTokenRetry({
            method,
            targetUrl,
            forwardHeaders,
            body,
            abortController,
            firstTokenTimeoutMs,
            firstTokenRetryAttempts,
            requestId,
          })
        : await retryWithBackoff(async () => {
            return await circuitBreaker.execute(async () => {
              return await this.client({
                method: method,
                url: targetUrl,
                headers: forwardHeaders,
                data: body,
                responseType: 'json',
                signal: abortController.signal,
              });
            });
          }, 3, 1000);

      res.status(response.status);

      // Пересылаем заголовки от upstream
      Object.entries(response.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(lowerKey)) {
          res.setHeader(key, value);
        }
      });

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        LoggerService.info('Stream connection established.');

        const spyStream = new PassThrough();
        let accumulatedText = '';
        let accumulatedThinking = '';

        // Регистрируем обработчик для накопления данных
        registerHandler(spyStream, 'data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
              try {
                const jsonStr = line.trim().substring(6);
                if (jsonStr === '[DONE]') continue;
                 
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta;

                if (delta) {
                  if (delta.content) {
                    accumulatedText += delta.content;
                  }
                  const reasoning = delta.reasoning_content || delta.reasoning;
                  if (reasoning) {
                    accumulatedThinking += reasoning;
                  }
                }
              } catch (e) { }
            }
          }
        });

        // Обработчик завершения потока
        registerHandler(spyStream, 'end', () => {
          const duration = Date.now() - requestStartTime;
          cleanup();
          LoggerService.logTraffic('res', 'STREAM FINISHED', {
            thoughts: accumulatedThinking || undefined,
            response: accumulatedText,
          });
          // Регистрация успешного запроса в метриках
          metricsService.finishRequestSuccess(requestId, response?.status || 200, {
            thoughts: accumulatedThinking || undefined,
            response: accumulatedText,
          }, duration);
        });

        // Обработчик ошибок в потоке данных
        registerHandler(spyStream, 'error', (err) => {
          LoggerService.error('SpyStream error', err);
          cleanup();
        });

        // Обработчик закрытия соединения клиентом
        registerHandler(res, 'close', () => {
          if (!res.writableEnded) {
            LoggerService.warn('Client closed connection. Destroying upstream stream.');
            abortController.abort('Client Disconnect');
            // Регистрация ошибки метрик при дисконнекте клиента
            const duration = Date.now() - requestStartTime;
            metricsService.finishRequestError(requestId, new Error('Client disconnected'), duration, 'client_disconnect');
          }
          cleanup();
        });

        // Обработчик ошибок в upstream потоке
        registerHandler(response.data, 'error', (err) => {
          LoggerService.error('Upstream stream error', err);
          const duration = Date.now() - requestStartTime;
          metricsService.finishRequestError(requestId, err, duration, 'upstream_stream_error');
          cleanup();
        });

        // Подключаем heartbeat если включен
        const streamHeartbeatConfig = currentConfig.upstream.streamHeartbeatEnabled
          ? {
              enabled: currentConfig.upstream.streamHeartbeatEnabled,
              intervalMs: currentConfig.upstream.streamHeartbeatIntervalMs ?? 30000,
              message: currentConfig.upstream.streamHeartbeatMessage ?? ':keep-alive',
            }
          : { enabled: false };

        if (streamHeartbeatConfig.enabled) {
          const heartbeatStream = new HeartbeatStream({
            intervalMs: streamHeartbeatConfig.intervalMs,
            heartbeatMessage: streamHeartbeatConfig.message,
          });
          
          registerHandler(heartbeatStream, 'error', (err) => {
            LoggerService.error('HeartbeatStream error', err);
            cleanup();
          });
          
          response.data.pipe(heartbeatStream).pipe(spyStream).pipe(res);
          
          LoggerService.info(`Heartbeat enabled (${streamHeartbeatConfig.intervalMs}ms interval)`);
        } else {
          response.data.pipe(spyStream).pipe(res);
        }

      } else {
        // Обработка не-стриминговых ответов
        const jsonData = response.data;
        cleanup();
        const duration = Date.now() - requestStartTime;
        
        // Регистрация в метриках
        if (response.status >= 400) {
          LoggerService.logTraffic('res', `ERROR RESPONSE (${response.status})`, {
            status: response.status,
            error: jsonData.error || jsonData,
          });
          metricsService.finishRequestError(requestId, new Error(`HTTP ${response.status}`), duration, 'http_error');
        } else {
          LoggerService.logTraffic('res', `JSON RESPONSE (${response.status})`, jsonData);
          metricsService.finishRequestSuccess(requestId, response.status, jsonData, duration);
        }
        
        res.json(jsonData);
      }

    } catch (error) {
      const duration = Date.now() - requestStartTime;
      cleanup();

      /** @type {Error} */
      const typedError = error instanceof Error ? error : new Error(String(error));

      // Handle FirstTokenTimeoutError - all retries exhausted
      if (typedError instanceof FirstTokenTimeoutError) {
        LoggerService.error(`First token timeout after all retries: ${typedError.message}`);
        metricsService.finishRequestError(requestId, typedError, duration, 'first_token_timeout_exhausted');
        
        const firstTokenTimeoutResponse = {
          error: {
            message: 'No tokens received from upstream model within the timeout period after multiple retries',
            type: 'first_token_timeout',
            code: 504,
          }
        };
        
        if (!res.headersSent) {
          res.status(504).json(firstTokenTimeoutResponse);
        }
        return;
      }

      if (axios.isCancel(typedError) || typedError?.name === 'AbortError' || typedError?.message === 'Request Timeout') {
        LoggerService.error(`Request aborted: ${typedError.message || 'Timeout'}`);
        metricsService.finishRequestError(requestId, typedError, duration, 'timeout');
        
        const timeoutResponse = {
          error: {
            message: typedError.message === 'Request Timeout' 
              ? 'Request timed out waiting for upstream model'
              : typedError.message,
            type: typedError.message === 'Request Timeout' ? 'timeout_error' : 'request_aborted',
            code: 504,
          }
        };
        
        if (!res.headersSent) {
          res.status(504).json(timeoutResponse);
        }
        return;
      }

      if (typedError.message && typedError.message.includes('Circuit Breaker')) {
        LoggerService.error('Circuit Breaker blocked request', null);
        metricsService.finishRequestError(requestId, typedError, duration, 'circuit_breaker');
        
        const cbResponse = {
          error: {
            message: 'Service temporarily unavailable due to repeated failures',
            type: 'service_unavailable',
            code: 503,
          }
        };
        
        if (!res.headersSent) {
          res.status(503).json(cbResponse);
        }
        return;
      }

      LoggerService.error('Fatal proxy error', null);
      metricsService.finishRequestError(requestId, typedError, duration, 'proxy_error');
      
      const errorResponse = {
        error: {
          message: 'Bad Gateway: Proxy connection failed',
          type: 'proxy_error',
          details: typedError.message,
        }
      };

      if (!res.headersSent) {
        res.status(502).json(errorResponse);
      }
    }
  }
}
