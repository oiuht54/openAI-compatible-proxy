import axios from 'axios';
import { PassThrough } from 'stream';
import { LoggerService } from '../utils/Logger.js';
import { configManager } from '../config/ConfigManager.js';

export class ProxyService {
  static activeControllers = new Set();

  static cancelAllRequests() {
    LoggerService.warn(`Force killing ${this.activeControllers.size} active requests...`);
    for (const controller of this.activeControllers) {
      controller.abort('Server Shutdown');
    }
    this.activeControllers.clear();
  }

  constructor() {
    this.client = axios.create({
      timeout: 0, 
      validateStatus: () => true,
    });
  }

  async forwardRequest(endpoint, method, headers, body, res) {
    const currentConfig = configManager.get();
    const upstreamConfig = currentConfig.upstream;
    const currentTimeoutMs = upstreamConfig.timeoutMs;

    const abortController = new AbortController();
    ProxyService.activeControllers.add(abortController);

    const timeoutId = setTimeout(() => {
      LoggerService.warn(`Request timed out after ${currentTimeoutMs}ms. Aborting...`);
      abortController.abort('Request Timeout');
    }, currentTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      ProxyService.activeControllers.delete(abortController);
    };

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

    LoggerService.logTraffic('req', `${method} ${targetUrl}`, body);

    const isStreaming = body.stream === true;

    try {
      const response = await this.client({
        method: method,
        url: targetUrl,
        headers: forwardHeaders,
        data: body,
        responseType: isStreaming ? 'stream' : 'json',
        signal: abortController.signal,
      });

      res.status(response.status);

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
        let accumulatedThinking = ''; // Добавили буфер для мыслей

        spyStream.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
              try {
                const jsonStr = line.trim().substring(6);
                if (jsonStr === '[DONE]') continue;
                
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta;

                if (delta) {
                    // 1. Ловим основной контент
                    if (delta.content) {
                        accumulatedText += delta.content;
                    }
                    // 2. Ловим мысли (Chain of Thought)
                    // Разные провайдеры используют разные поля, проверяем основные
                    const reasoning = delta.reasoning_content || delta.reasoning;
                    if (reasoning) {
                        accumulatedThinking += reasoning;
                    }
                }
              } catch (e) { }
            }
          }
        });

        spyStream.on('end', () => {
          cleanup(); 
          // Выводим полный отчет с мыслями и ответом
          LoggerService.logTraffic('res', 'STREAM FINISHED (Full Log)', { 
              thoughts: accumulatedThinking || undefined, // undefined чтобы поле не выводилось если мыслей нет
              response: accumulatedText 
          });
        });

        res.on('close', () => {
          if (!res.writableEnded) {
             LoggerService.warn('Client closed connection. Destroying upstream stream.');
             abortController.abort('Client Disconnect'); 
          }
          cleanup();
        });

        response.data.pipe(spyStream).pipe(res);

        response.data.on('error', (err) => {
             LoggerService.error('Stream Data Error', err);
             cleanup();
        });

      } else {
        const jsonData = response.data;
        cleanup();
        LoggerService.logTraffic('res', `JSON RESPONSE (${response.status})`, jsonData);
        res.json(jsonData);
      }

    } catch (error) {
      cleanup();

      if (axios.isCancel(error) || error.name === 'AbortError' || error.message === 'Request Timeout') {
        LoggerService.error(`Request aborted: ${error.message || 'Timeout'}`);
        
        const timeoutResponse = {
          error: {
            message: 'Request timed out waiting for upstream model',
            type: 'timeout_error',
            code: 504
          }
        };
        
        if (!res.headersSent) {
          res.status(504).json(timeoutResponse);
        }
        return;
      }

      LoggerService.error('Fatal proxy error', error);
      
      const errorResponse = {
        error: {
          message: 'Bad Gateway: Proxy connection failed',
          type: 'proxy_error',
          details: error.message
        }
      };

      if (!res.headersSent) {
        res.status(502).json(errorResponse);
      }
    }
  }
}