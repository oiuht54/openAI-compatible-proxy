import { RequestTransformer } from '../services/RequestTransformer.js';
import { ProxyService } from '../services/ProxyService.js';
import { LoggerService } from '../utils/Logger.js';

export class ChatController {
    constructor() {
        // Сервисы теперь сами берут актуальный конфиг
        this.transformer = new RequestTransformer();
        this.proxyService = new ProxyService();
    }

    handleChatCompletions = async (req, res) => {
        try {
            const originalBody = req.body;

            if (!originalBody || typeof originalBody !== 'object') {
                return res.status(400).json({ error: 'Invalid JSON body' });
            }

            const modifiedBody = this.transformer.transform(originalBody);

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
                res.status(500).json({ error: 'Internal Proxy Error' });
            }
        }
    };
}