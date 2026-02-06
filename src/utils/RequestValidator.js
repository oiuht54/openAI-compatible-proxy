import { z } from 'zod';
import { LoggerService } from './Logger.js';

/**
 * Схемы валидации для запросов к OpenAI API
 */

// Базовая схема сообщения в чате
const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
}, { invalid_type_error: 'Invalid message format' });

// Основная схема запроса для chat completions
export const ChatCompletionRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1, 'At least one message is required'),
  model: z.string().min(1, 'Model is required'),
  
  // Опциональные параметры
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).max(128).optional(),
  stream: z.boolean().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().min(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  
  // NVIDIA-specific параметры
  chat_template_kwargs: z.record(z.any()).optional(),
  
  // Параметры для функции вызова (function calling)
  functions: z.array(z.any()).optional(),
  function_call: z.union([z.enum(['auto', 'none']), z.object({
    name: z.string(),
  })]).optional(),
  
  // Параметры для tool calling
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
    }),
  })]).optional(),
  
  // Параметры ответа
  response_format: z.object({
    type: z.enum(['text', 'json_object']),
  }).optional(),
  
  // Seed для воспроизводимости
  seed: z.number().int().optional(),
}, { invalid_type_error: 'Invalid request format' });

/**
 * Класс для валидации входящих запросов
 */
export class RequestValidator {
  /**
   * Валидирует тело запроса chat completions
   * @param {any} body - Тело запроса
   * @returns {{ success: boolean, data?: object, errors?: string[] }}
   */
  static validateChatCompletion(body) {
    try {
      const validated = ChatCompletionRequestSchema.parse(body);
      return { success: true, data: validated };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map(err => {
          const path = err.path.join('.');
          return `${path ? path + ': ' : ''}${err.message}`;
        });
        
        LoggerService.warn('Request validation failed', { errors });
        
        return { 
          success: false, 
          errors,
          errorDetails: error.errors 
        };
      }
      
      return { 
        success: false, 
        errors: [error.message] 
      };
    }
  }

  /**
   * Создаёт стандартный ответ об ошибке валидации
   * @param {string[]} errors - Список ошибок
   * @returns {object}
   */
  static createValidationError(errors) {
    return {
      error: {
        message: 'Invalid request format',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request',
        details: errors,
      }
    };
  }
}
