import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { LoggerService } from '../utils/Logger.js';

// Для определения пути к файлу в ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Схема валидации
const ConfigSchema = z.object({
    server: z.object({
        port: z.number().default(3000),
        host: z.string().default('0.0.0.0'),
    }),
    upstream: z.object({
        url: z.string().url(),
        timeoutMs: z.number().positive().default(60000),
        apiKey: z.string().optional(),
    }),
    // Секция инъекций
    injection: z.object({
        forceModel: z.string().optional(),
        parameters: z.record(z.any()).optional(),

        // Новая настройка: Включить/Выключить добавление chat_template_kwargs
        enableChatTemplateKwargs: z.boolean().default(true),

        chatTemplateKwargs: z.record(z.any()).optional(),
    }).optional().default({}),
});

class ConfigManager {
    constructor() {
        this.config = null;
        // Путь к config.json - ищем сначала в root, затем в src/
        const possiblePaths = [
            path.resolve(process.cwd(), 'config.json'),
            path.resolve(process.cwd(), 'src', 'config.json'),
            path.resolve(__dirname, '..', '..', 'config.json'),
            path.resolve(__dirname, '..', 'config.json'),
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                this.configPath = p;
                break;
            }
        }
        if (!this.configPath) {
            this.configPath = possiblePaths[3]; // Fallback: src/config.json
        }
        this.isReloading = false;
    }

    loadConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
                throw new Error(`Configuration file not found at: ${this.configPath}`);
            }

            const rawData = fs.readFileSync(this.configPath, 'utf-8');

            // Защита от пустого файла
            if (!rawData.trim()) return;

            const parsedJson = JSON.parse(rawData);

            // Валидация
            this.config = ConfigSchema.parse(parsedJson);

            LoggerService.info('Configuration loaded/reloaded successfully.');

            // Логируем состояние
            const injection = this.config.injection;
            if (injection) {
                if (injection.forceModel) {
                    LoggerService.warn(`⚠️  Model Force Override: "${injection.forceModel}"`);
                }
                LoggerService.info(`🔧 Chat Template Injection: ${injection.enableChatTemplateKwargs ? 'ENABLED' : 'DISABLED'}`);
            }

        } catch (error) {
            LoggerService.error('Failed to load configuration', error);
            if (!this.config) process.exit(1);
        }
    }

    enableHotReload() {
        LoggerService.info(`Watching for changes in: ${this.configPath}`);
        let debounceTimer = null;

        try {
            fs.watch(this.configPath, (eventType, filename) => {
                if (!filename) return;

                if (debounceTimer) clearTimeout(debounceTimer);

                debounceTimer = setTimeout(() => {
                    LoggerService.info(`Config file changed (${eventType}). Reloading...`);
                    this.loadConfig();
                }, 100);
            });
        } catch (err) {
            LoggerService.error('Failed to setup file watcher', err);
        }
    }

    get() {
        if (!this.config) {
            throw new Error('Config not loaded. Call loadConfig() first.');
        }
        return this.config;
    }
}

export const configManager = new ConfigManager();