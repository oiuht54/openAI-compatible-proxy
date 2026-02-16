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
   * @param {(error?: Error) => void} options.onError - callback при ошибке
   */
  constructor({ intervalMs, heartbeatMessage, onError }) {
    super({ decodeStrings: false });
    this.intervalMs = intervalMs;
    this.heartbeatMessage = heartbeatMessage;
    this.lastActivityTime = Date.now();
    /** @type {NodeJS.Timeout|null} */
    this.heartbeatTimer = null;
    this.ended = false;
    this.onError = onError;
    
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
        try {
          this.push(this.heartbeatMessage + '\n');
          LoggerService.debug(`Heartbeat sent (${timeSinceActivity}ms since last data)`);
        } catch (error) {
          if (!this.ended) {
            this.stopHeartbeat();
            if (this.onError) this.onError(/** @type {Error} */ (error));
          }
        }
      }
      
      this.heartbeatTimer = setTimeout(sendHeartbeat, this.intervalMs);
    };
    
    this.heartbeatTimer = setTimeout(sendHeartbeat, this.intervalMs);
  }

  stopHeartbeat() {
    this.ended = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Принудительная остановка с очисткой
   */
  forceDestroy() {
    this.stopHeartbeat();
    this.removeAllListeners();
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
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, signal) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      const err = /** @type {any} */ (error);
      if (err.response && typeof err.response.status === 'number' && 
          err.response.status >= 400 && err.response.status < 500) {
        throw error;
      }
      
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        LoggerService.warn(`Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms...`);
        
        await Promise.race([
          new Promise(resolve => setTimeout(resolve, delay)),
          signal ? new Promise((_, reject) => {
            const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
          }) : Promise.resolve(),
        ]);
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
  /** @type {Map<AbortController, {cleanup: () => void, requestId: string}>} */
  static activeControllers = new Map();

  /**
   * @param {AbortController} controller
   * @param {() => void} cleanup
   * @param {string} requestId
   */
  static registerController(controller, cleanup, requestId) {
    this.activeControllers.set(controller, { cleanup, requestId });
  }

  /**
   * @param {AbortController} controller
   */
  static unregisterController(controller) {
    this.activeControllers.delete(controller);
  }

  static cancelAllRequests() {
    LoggerService.warn(`Force killing ${this.activeControllers.size} active requests...`);
    for (const [controller, { cleanup }] of this.activeControllers) {
      try {
        controller.abort('Server Shutdown');
        cleanup();
      } catch (err) {
        LoggerService.error('Error during request cleanup on shutdown', null);
      }
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
      timeout: 60000,
      maxRedirects: 5,
      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        maxFreeSockets: 50,
        timeout: 60000,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        maxFreeSockets: 50,
        timeout: 60000,
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
    let lastError = new FirstTokenTimeoutError('First token timeout', 0);

    for (let attempt = 0; attempt <= firstTokenRetryAttempts; attempt++) {
      const attemptController = attempt === 0 ? abortController : new AbortController();
      let firstTokenReceived = false;
      /** @type {NodeJS.Timeout|null} */
      let firstTokenTimeoutId = null;
      const attemptStartTime = Date.now();
      
      /** @type {PassThrough | null} */
      let bufferedStream = null;
      /** @type {Buffer[]} */
      let savedChunks = [];
      /** @type {((chunk: Buffer) => void) | null} */
      let checkForFirstToken = null;
      /** @type {import('stream').Readable | null} */
      let originalResponseData = null;

      try {
        if (attempt > 0 && abortController.signal.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        bufferedStream = new PassThrough({
          autoDestroy: true,
        });
        savedChunks = [];
        
        /** @type {(value: null) => void} */
        let firstTokenResolve = () => {};
        
        const firstTokenPromise = new Promise((resolve) => {
          firstTokenResolve = /** @type {(value: null) => void} */ (resolve);
          
          firstTokenTimeoutId = setTimeout(() => {
            const elapsed = Date.now() - attemptStartTime;
             
            if (!firstTokenReceived) {
              LoggerService.warn(`[FirstTokenTimeout] Timer expired after ${elapsed}ms - aborting request`, {
                requestId,
                attempt: attempt + 1,
                elapsed,
                timeout: firstTokenTimeoutMs,
              });
              attemptController.abort('First Token Timeout');
              resolve(null);
            }
          }, firstTokenTimeoutMs);
        });
        
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
          if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
          return response;
        }

        originalResponseData = response.data;

        checkForFirstToken = (/** @type {Buffer} */ chunk) => {
          savedChunks.push(chunk);
          
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
              const jsonStr = line.trim().substring(6);
              if (jsonStr === '[DONE]') {
                continue;
              }
              try {
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta;
                if (delta && (delta.content || delta.reasoning_content || delta.reasoning)) {
                  firstTokenReceived = true;
                  const elapsed = Date.now() - attemptStartTime;
                  if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
                  
                  LoggerService.info(`[FirstTokenTimeout] First token received after ${elapsed}ms`, {
                    requestId,
                    elapsed,
                    timeout: firstTokenTimeoutMs,
                  });
                  
                  if (checkForFirstToken) {
                    response.data.off('data', checkForFirstToken);
                  }
                  savedChunks.forEach((c) => {
                    try {
                      if (bufferedStream) bufferedStream.write(c);
                    } catch (err) {
                    }
                  });
                  if (firstTokenResolve) firstTokenResolve(null);
                  return;
                }
              } catch (e) {
              }
            }
          }
        };

        response.data.on('data', checkForFirstToken);
        
        response.data.once('end', () => {
          savedChunks.forEach((c) => {
            try {
              if (bufferedStream) bufferedStream.write(c);
            } catch (err) {
            }
          });
          try {
            if (bufferedStream) bufferedStream.end();
          } catch (err) {
          }
             
          if (checkForFirstToken) {
            response.data.off('data', checkForFirstToken);
          }
          if (!firstTokenReceived && firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId);
          }
        });
        
        response.data.once('error', (/** @type {Error} */ err) => {
          if (checkForFirstToken) {
            response.data.off('data', checkForFirstToken);
          }
          if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
          try {
            if (bufferedStream) bufferedStream.destroy(err);
          } catch (e) {
          }
        });
        
        response.data.once('close', () => {
          if (checkForFirstToken) {
            response.data.off('data', checkForFirstToken);
          }
          if (!firstTokenReceived && firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId);
          }
        });
        
        await firstTokenPromise;
        
        response.data = bufferedStream;
        
        if (originalResponseData) {
          originalResponseData.pipe(bufferedStream, { end: true });
        }
        
        return response;

      } catch (error) {
        if (firstTokenTimeoutId) {
          clearTimeout(firstTokenTimeoutId);
        }

        // Удаляем обработчик событий
        if (originalResponseData && checkForFirstToken) {
          originalResponseData.off('data', checkForFirstToken);
        }

        // Уничтожаем bufferedStream если был создан
        if (bufferedStream) {
          try {
            bufferedStream.destroy();
          } catch (err) {
          }
        }

        // Уничтожаем исходный поток от upstream при ошибке или abort
        if (originalResponseData) {
          try {
            originalResponseData.destroy();
          } catch (err) {
            // Игнорируем ошибки при уничтожении уже закрытого потока
          }
        }

        /** @type {any} */
        const err = error && typeof error === 'object' ? error : null;

        const isAbortedError = err && (
          err.code === 'ERR_CANCELED' ||
          err.code === 'ECONNABORTED' ||
          err.message?.includes('canceled') ||
          err.message?.includes('aborted') ||
          error instanceof DOMException && error.name === 'AbortError'
        );

        const isMainControllerAborted = abortController.signal.aborted;

        if (isMainControllerAborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        if (isAbortedError) {
          const timeoutError = new FirstTokenTimeoutError(`No tokens received within ${firstTokenTimeoutMs}ms`, attempt);
          
          LoggerService.warn(`[FirstTokenTimeout] First token timeout occurred (attempt ${attempt + 1}/${firstTokenRetryAttempts + 1}). Retrying...`, {
            requestId,
            attempt: attempt + 1,
            message: timeoutError.message,
          });
          
          lastError = timeoutError;
          metricsService.finishRequestError(requestId, timeoutError, 0, 'first_token_timeout');
          
          if (attempt < firstTokenRetryAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          continue;
        }

        if (error instanceof FirstTokenTimeoutError) {
          LoggerService.warn(`[FirstTokenTimeout] First token timeout occurred (attempt ${attempt + 1}/${firstTokenRetryAttempts + 1}). Retrying...`, {
            requestId,
            attempt: attempt + 1,
            message: error.message,
          });
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

    LoggerService.info(`[FirstTokenTimeout] All retry attempts exhausted for request`, {
      requestId,
      totalAttempts: firstTokenRetryAttempts + 1,
      errorMessage: lastError?.message,
    });
    
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
    /** @type {NodeJS.Timeout | null} */
    let streamFallbackTimeoutId = null;
    
    /** @type {Array<{emitter: import('events').EventEmitter, event: string, handler: (...args: any[]) => void}>} */
    /** @type {Array<{emitter: import('events').EventEmitter, event: string, handler: (...args: any[]) => void}>} */
    const eventHandlers = [];

    /** @type {Array<{stream: any, destroy: boolean}>} */
    const streamsToDestroy = [];

    /**
     * @param {import('events').EventEmitter} emitter
     * @param {string} event
     * @param {(...args: any[]) => void} handler
     */
    const registerHandler = (emitter, event, handler) => {
      eventHandlers.push({ emitter, event, handler });
      emitter.on(event, handler);
    };

    /**
     * @param {any} stream
     * @param {boolean} destroy
     */
    const registerStream = (stream, destroy = true) => {
      streamsToDestroy.push({ stream, destroy });
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      
      LoggerService.debug('[Cleanup] Starting cleanup for request');
      
      if (streamFallbackTimeoutId) {
        clearTimeout(streamFallbackTimeoutId);
        streamFallbackTimeoutId = null;
      }
      
      eventHandlers.forEach(({ emitter, event, handler }) => {
        try {
          emitter.off(event, handler);
        } catch (err) {
        }
      });
      eventHandlers.length = 0;
      
      streamsToDestroy.forEach(({ stream, destroy }) => {
        try {
          if (destroy) {
            stream.destroy();
          } else {
            stream.end();
          }
        } catch (err) {
        }
      });
      streamsToDestroy.length = 0;
      
      ProxyService.unregisterController(abortController);
      
      LoggerService.debug('[Cleanup] Cleanup completed');
    };

    const requestId = metricsService.startRequest(method, endpoint, headers, body);
    ProxyService.registerController(abortController, cleanup, requestId);

    const timeoutId = setTimeout(() => {
      LoggerService.warn(`Request timed out after ${currentTimeoutMs}ms. Aborting...`, { requestId });
      abortController.abort('Request Timeout');
    }, currentTimeoutMs);

    const timeoutCleanup = () => {
      clearTimeout(timeoutId);
    };
    eventHandlers.push({
      emitter: /** @type {any} */ (null),
      event: 'timeout',
      handler: timeoutCleanup,
    });

    const baseUrl = upstreamConfig.url.replace(/\/$/, "");
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const targetUrl = `${baseUrl}${cleanEndpoint}`;
    
    const forwardHeaders = { ...headers };
    
    delete forwardHeaders['host'];
    delete forwardHeaders['content-length'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['accept-encoding']; 
    
    if (upstreamConfig.apiKey) {
      forwardHeaders['authorization'] = `Bearer ${upstreamConfig.apiKey}`;
    }

    LoggerService.logTraffic('req', `${method} ${targetUrl}`, {
      headers: filterSensitiveHeaders(forwardHeaders),
      body: body,
    });

    const isStreaming = body?.stream === true;
    const requestStartTime = Date.now();
    const firstTokenTimeoutMs = upstreamConfig.firstTokenTimeoutMs || 20000;
    const firstTokenRetryAttempts = upstreamConfig.firstTokenRetryAttempts || 2;
    const streamFallbackTimeoutMs = /** @type {number} */ (upstreamConfig.streamFallbackTimeoutMs) || currentTimeoutMs;

    LoggerService.debug(`[Proxy] Stream detection`, {
      requestId,
      isStreaming,
      streamValue: body?.stream,
    });

    try {
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
          }, 3, 1000, abortController.signal);

      if (abortController.signal.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      res.status(response.status);

      Object.entries(response.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(lowerKey)) {
          try {
            res.setHeader(key, value);
          } catch (err) {
          }
        }
      });

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        LoggerService.info('Stream connection established.', { requestId });

        const spyStream = new PassThrough({
          autoDestroy: true,
        });
        registerStream(spyStream, false);
        
        let accumulatedText = '';
        let accumulatedThinking = '';
        let streamCompleted = false;

        if (streamFallbackTimeoutMs > 0) {
          streamFallbackTimeoutId = setTimeout(() => {
            if (!streamCompleted && !cleanedUp) {
              LoggerService.warn(`[StreamFallback] Stream timeout after ${streamFallbackTimeoutMs}ms. Force closing.`, { requestId });
              try {
                spyStream.end();
              } catch (err) {
              }
              cleanup();
            }
          }, streamFallbackTimeoutMs);
        }

        registerHandler(spyStream, 'data', (/** @type {Buffer} */ chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
              try {
                const jsonStr = line.trim().substring(6);
                if (jsonStr === '[DONE]') {
                  streamCompleted = true;
                  continue;
                }
                 
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

        registerHandler(spyStream, 'end', () => {
          streamCompleted = true;
          if (streamFallbackTimeoutId) {
            clearTimeout(streamFallbackTimeoutId);
            streamFallbackTimeoutId = null;
          }
          
          const duration = Date.now() - requestStartTime;
          cleanup();
          
          LoggerService.logTraffic('res', 'STREAM FINISHED', {
            requestId,
            thoughts: accumulatedThinking || undefined,
            response: accumulatedText,
          });
          
          metricsService.finishRequestSuccess(requestId, response?.status || 200, {
            thoughts: accumulatedThinking || undefined,
            response: accumulatedText,
          }, duration);
        });

        registerHandler(spyStream, 'error', (/** @type {Error} */ err) => {
          LoggerService.error('SpyStream error', null);
          cleanup();
          
          const duration = Date.now() - requestStartTime;
          metricsService.finishRequestError(requestId, err, duration, 'spy_stream_error');
        });

        registerHandler(spyStream, 'close', () => {
          if (!streamCompleted && !cleanedUp) {
            LoggerService.warn('SpyStream closed unexpectedly', { requestId });
            cleanup();
            
            const duration = Date.now() - requestStartTime;
            if (duration > 0) {
              metricsService.finishRequestError(requestId, new Error('Stream closed unexpectedly'), duration, 'stream_unexpected_close');
            }
          }
        });

        registerHandler(res, 'close', () => {
          if (!res.writableEnded && !cleanedUp) {
            LoggerService.warn('Client closed connection. Destroying upstream stream.', { requestId });
            abortController.abort('Client Disconnect');
            
            const duration = Date.now() - requestStartTime;
            metricsService.finishRequestError(requestId, new Error('Client disconnected'), duration, 'client_disconnect');
            cleanup();
          }
        });

        registerHandler(res, 'finish', () => {
          LoggerService.debug('Response finish event', { requestId });
        });

        registerHandler(response.data, 'error', (/** @type {Error} */ err) => {
          LoggerService.error('Upstream stream error', null);
          const duration = Date.now() - requestStartTime;
          metricsService.finishRequestError(requestId, err, duration, 'upstream_stream_error');
          cleanup();
        });

        registerHandler(response.data, 'end', () => {
          LoggerService.debug('Upstream stream ended', { requestId });
        });

        registerHandler(response.data, 'close', () => {
          LoggerService.debug('Upstream stream closed', { requestId });
        });

        if (currentConfig.upstream.streamHeartbeatEnabled) {
          const heartbeatStream = new HeartbeatStream({
            intervalMs: currentConfig.upstream.streamHeartbeatIntervalMs ?? 30000,
            heartbeatMessage: currentConfig.upstream.streamHeartbeatMessage ?? ':keep-alive',
            onError: (err) => {
              LoggerService.error('HeartbeatStream error', null);
              cleanup();
            }
          });
          registerStream(heartbeatStream);
          
          LoggerService.info(`Heartbeat enabled (${currentConfig.upstream.streamHeartbeatIntervalMs ?? 30000}ms interval)`, { requestId });
          
          response.data
            .pipe(heartbeatStream)
            .pipe(spyStream)
            .pipe(res)
            .on('error', (/** @type {Error} */ err) => {
              LoggerService.error('Pipeline error', null);
              cleanup();
            });
        } else {
          response.data
            .pipe(spyStream)
            .pipe(res)
            .on('error', (/** @type {Error} */ err) => {
              LoggerService.error('Pipeline error', null);
              cleanup();
            });
        }

      } else {
        const jsonData = response.data;
        cleanup();
        
        const duration = Date.now() - requestStartTime;
        
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
        
        if (!res.headersSent) {
          res.json(jsonData);
        }
      }

    } catch (error) {
      const duration = Date.now() - requestStartTime;
      
      const headersAlreadySent = res.headersSent;
      cleanup();

      const typedError = error instanceof Error ? error : new Error(String(error));

      if (typedError instanceof FirstTokenTimeoutError) {
        LoggerService.error(`First token timeout after all retries: ${typedError.message}`, null);
        metricsService.finishRequestError(requestId, typedError, duration, 'first_token_timeout_exhausted');
        
        if (!headersAlreadySent) {
          const firstTokenTimeoutResponse = {
            error: {
              message: 'No tokens received from upstream model within the timeout period after multiple retries',
              type: 'first_token_timeout',
              code: 504,
            }
          };
          res.status(504).json(firstTokenTimeoutResponse);
        }
        return;
      }

      if (typedError.name === 'AbortError' || axios.isCancel(typedError) || typedError?.message === 'Request Timeout') {
        LoggerService.error(`Request aborted: ${typedError.message || 'Timeout'}`, null);
        metricsService.finishRequestError(requestId, typedError, duration, 'timeout');
        
        if (!headersAlreadySent) {
          const timeoutResponse = {
            error: {
              message: typedError.message === 'Request Timeout' 
                ? 'Request timed out waiting for upstream model'
                : typedError.message,
              type: typedError.message === 'Request Timeout' ? 'timeout_error' : 'request_aborted',
              code: 504,
            }
          };
          res.status(504).json(timeoutResponse);
        }
        return;
      }

      if (typedError.message && typedError.message.includes('Circuit Breaker')) {
        LoggerService.error('Circuit Breaker blocked request', null);
        metricsService.finishRequestError(requestId, typedError, duration, 'circuit_breaker');
        
        if (!headersAlreadySent) {
          const cbResponse = {
            error: {
              message: 'Service temporarily unavailable due to repeated failures',
              type: 'service_unavailable',
              code: 503,
            }
          };
          res.status(503).json(cbResponse);
        }
        return;
      }

      LoggerService.error(`Fatal proxy error: ${typedError.message}`, null);
      metricsService.finishRequestError(requestId, typedError, duration, 'proxy_error');
      
      if (!headersAlreadySent) {
        const errorResponse = {
          error: {
            message: 'Bad Gateway: Proxy connection failed',
            type: 'proxy_error',
            details: typedError.message,
          }
        };
        res.status(502).json(errorResponse);
      }
    }
  }
}
