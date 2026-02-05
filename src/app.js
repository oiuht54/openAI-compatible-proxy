import express from 'express';
import bodyParser from 'body-parser';
import { ChatController } from './controllers/ChatController.js';
import { LoggerService } from './utils/Logger.js';

export function createApp() {
    const app = express();

    // Отключаем метку, что это Express (безопасность + чистота заголовков)
    app.disable('x-powered-by');

    // Увеличиваем лимит
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

    const chatController = new ChatController();

    app.use((req, res, next) => {
        LoggerService.info(`Incoming ${req.method} request`, { url: req.url, ip: req.ip });
        next();
    });

    app.post('/chat/completions', (req, res) => chatController.handleChatCompletions(req, res));

    app.post('/v1/chat/completions', (req, res) => {
        req.url = '/chat/completions';
        chatController.handleChatCompletions(req, res)
    });

    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    app.use((req, res) => {
        res.status(404).json({ error: 'Not Found' });
    });

    return app;
}