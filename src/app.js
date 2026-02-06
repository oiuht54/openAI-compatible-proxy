import express from 'express';
import bodyParser from 'body-parser';
import { ChatController } from './controllers/ChatController.js';
import { DashboardController } from './controllers/DashboardController.js';
import { LoggerService } from './utils/Logger.js';

export function createApp() {
    const app = express();

    // Отключаем метку, что это Express (безопасность + чистота заголовков)
    app.disable('x-powered-by');
    
    // Добавляем заголовки безопасности
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.removeHeader('X-Powered-By');
        next();
    });

    // Уменьшаем лимит (DoS защита)
    app.use(bodyParser.json({ limit: '10mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

    const chatController = new ChatController();

    // Middleware для логирования запросов (кроме dashboard для уменьшения шума)
    app.use((req, res, next) => {
        if (!req.url.startsWith('/api/dashboard')) {
            LoggerService.info(`Incoming ${req.method} request`, { url: req.url, ip: req.ip });
        }
        next();
    });

    // Dashboard API routes
    app.get('/dashboard', (req, res) => DashboardController.serveDashboard(req, res));
    app.get('/', (req, res) => DashboardController.serveDashboard(req, res));
    
    app.get('/api/dashboard/stats', (req, res) => DashboardController.getStats(req, res));
    app.get('/api/dashboard/requests', (req, res) => DashboardController.getRequests(req, res));
    app.get('/api/dashboard/requests/:id', (req, res) => DashboardController.getRequest(req, res));
    app.get('/api/dashboard/circuit-breaker', (req, res) => DashboardController.getCircuitBreakerStatus(req, res));
    app.post('/api/dashboard/reset', (req, res) => DashboardController.resetStats(req, res));
    app.post('/api/dashboard/clear', (req, res) => DashboardController.clearAll(req, res));

    // Main API routes
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