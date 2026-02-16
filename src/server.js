import { createApp } from './app.js';
import { configManager } from './config/ConfigManager.js';
import { LoggerService } from './utils/Logger.js';
import { ProxyService } from './services/ProxyService.js';

async function startServer() {
    try {
        // 1. Загрузка конфигурации
        configManager.loadConfig();

        // 2. Включаем автоматическое отслеживание изменений (для Windows/Linux)
        configManager.enableHotReload();

        let config = configManager.get();

        const app = createApp();
        const port = config.server.port;
        const host = config.server.host;

        const server = app.listen(port, host, () => {
            LoggerService.info(`OpenAI Proxy Server is running on http://${host}:${port}`);
            LoggerService.info(`Upstream target: ${config.upstream.url}`);
            LoggerService.info('Hot Reload is ACTIVE: Just save config.json to apply changes.');
        });

        // Оптимизированные таймауты для стриминговых запросов с очень медленными моделями
        server.keepAliveTimeout = 7200000; // 2 часа для long-lived стриминговых соединений
        server.headersTimeout = 7205000;   // 5 секунд больше keepAliveTimeout
        server.requestTimeout = 3600000;   // 60 минут для очень медленных запросов

        const shutdown = () => {
            LoggerService.info('\n🛑 Received kill signal. Shutting down...');
            ProxyService.cancelAllRequests();
            server.close(() => {
                LoggerService.info('Server closed. Bye!');
                process.exit(0);
            });

            setTimeout(() => {
                LoggerService.error('Force exiting...');
                process.exit(1);
            }, 3000);
        };

        // Windows (Ctrl+C) посылает SIGINT.
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        LoggerService.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();