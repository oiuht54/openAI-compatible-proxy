import pino from 'pino';

const logger = pino({
    level: 'debug', // Включаем debug для подробностей
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            singleLine: false, // Разрешаем многострочный вывод
        },
    },
});

export class LoggerService {
    static info(message, meta = {}) {
        logger.info(meta, message);
    }

    static error(message, error = null) {
        logger.error({ err: error }, message);
    }

    static warn(message, meta = {}) {
        logger.warn(meta, message);
    }

    static debug(message, meta = {}) {
        logger.debug(meta, message);
    }

    // Специальный метод для красивого отображения JSON блоков
    static logTraffic(type, title, payload) {
        const separator = '='.repeat(50);
        const icon = type === 'req' ? '🚀 OUTGOING REQUEST' : '📥 INCOMING RESPONSE';

        // Преобразуем объект в красивую строку
        let content = '';
        if (typeof payload === 'object') {
            content = JSON.stringify(payload, null, 2);
        } else {
            content = String(payload);
        }

        console.log(`\n${separator}`);
        console.log(`${icon}: ${title}`);
        console.log(`timestamp: ${new Date().toLocaleTimeString()}`);
        console.log('-'.repeat(50));
        console.log(content);
        console.log(`${separator}\n`);
    }
}