import pino from 'pino';
import { Writable } from 'stream';

// Асинхронный writable stream для вывода логов
const asyncConsoleStream = new Writable({
  write(chunk, encoding, callback) {
    process.nextTick(() => {
      process.stdout.write(chunk, encoding);
      callback();
    });
  },
});

const logger = pino({
  level: 'info', // Уменьшили уровень логирования для продакшена
}, pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    singleLine: false,
  },
}));

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

  // Асинхронный метод для отображения JSON блоков (включая трассировку запросов)
  static logTraffic(type, title, payload) {
    // Используем setImmediate для неблокирующего вывода
    setImmediate(() => {
      const separator = '='.repeat(50);
      const icon = type === 'req' ? '🚀 OUTGOING REQUEST' : '📥 INCOMING RESPONSE';

      let content = '';
      if (typeof payload === 'object') {
        content = JSON.stringify(payload, null, 2);
      } else {
        content = String(payload);
      }

      // Выводим асинхронно через process.nextTick
      const lines = [
        '',
        separator,
        `${icon}: ${title}`,
        `timestamp: ${new Date().toLocaleTimeString()}`,
        '-'.repeat(50),
        content,
        separator,
        '',
      ];

      // Асинхронный вывод каждой строки
      let i = 0;
      const writeLine = () => {
        if (i < lines.length) {
          process.stdout.write(lines[i] + '\n');
          i++;
          setImmediate(writeLine);
        }
      };
      writeLine();
    });
  }
}
