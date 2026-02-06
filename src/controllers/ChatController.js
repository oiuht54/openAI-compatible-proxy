import { RequestTransformer } from '../services/RequestTransformer.js';
import { ProxyService } from '../services/ProxyService.js';
import { LoggerService } from '../utils/Logger.js';
import { RequestValidator } from '../utils/RequestValidator.js';

export class ChatController {
    constructor() {
        // Сервисы теперь сами берут актуальный конфиг
        this.transformer = new RequestTransformer();
        this.proxyService = new ProxyService();
    }

    handleChatCompletions = async (req, res) => {
        try {
            const originalBody = req.body;

            // 1. Проверка базовой валидности JSON
            if (!originalBody || typeof originalBody !== 'object') {
                return res.status(400).json({
                    error: {
                        message: 'Invalid JSON body',
                        type: 'invalid_request_error',
                        code: 'invalid_json',
                    }
                });
            }

            // 2. Валидация схемы запроса с использованием Zod
            const validation = RequestValidator.validateChatCompletion(originalBody);
            if (!validation.success) {
                return res.status(400).json(
                    RequestValidator.createValidationError(validation.errors)
                );
            }

            // Используем валидированные данные
            const modifiedBody = this.transformer.transform(validation.data);

            await this.proxyService.forwardRequest(
                req.path,
                req.method,
                req.headers,
                modifiedBody,
                res
            );

        } catch (error) {
            LoggerService.error('Controller error', error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: 'Internal Proxy Error',
                        type: 'internal_error',
                        code: 'internal_error',
                    }
                });
            }
        }
    };
}