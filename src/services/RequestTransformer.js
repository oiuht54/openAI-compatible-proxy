import { LoggerService } from '../utils/Logger.js';
import { configManager } from '../config/ConfigManager.js';

export class RequestTransformer {
    constructor() {}

    transform(originalBody) {
        // Получаем свежий конфиг
        const injectionConfig = configManager.get().injection || {};

        const transformedBody = { ...originalBody };

        // 1. Логика модели
        if (injectionConfig.forceModel && injectionConfig.forceModel.trim() !== '') {
            LoggerService.debug(`[Model Override] Changing model from "${originalBody.model}" to "${injectionConfig.forceModel}"`);
            transformedBody.model = injectionConfig.forceModel;
        } else {
            LoggerService.debug(`[Model Pass-through] Using client model: "${originalBody.model}"`);
        }

        // 2. Инъекция простых параметров (temperature, top_p...)
        if (injectionConfig.parameters) {
            for (const [key, value] of Object.entries(injectionConfig.parameters)) {
                transformedBody[key] = value;
            }
        }

        // 3. Инъекция chat_template_kwargs (ТОЛЬКО ЕСЛИ ВКЛЮЧЕНО)
        if (injectionConfig.enableChatTemplateKwargs) {
            const existingTemplateKwargs = transformedBody.chat_template_kwargs || {};
            const configTemplateKwargs = injectionConfig.chatTemplateKwargs || {};

            // Если есть что добавлять
            if (Object.keys(configTemplateKwargs).length > 0 || Object.keys(existingTemplateKwargs).length > 0) {
                transformedBody.chat_template_kwargs = {
                    ...existingTemplateKwargs,
                    ...configTemplateKwargs,
                };
            }
        } else {
            // Если отключено - не трогаем это поле.
            // Если клиент прислал его - оно останется. Если мы хотим принудительно удалять,
            // нужно добавить delete transformedBody.chat_template_kwargs;
            // Но обычно "отключить инъекцию" значит "не вмешиваться".
            LoggerService.debug('[Template Injection] Skipped by config (enableChatTemplateKwargs=false)');
        }

        LoggerService.debug('Request body transformed', {
            finalModel: transformedBody.model,
            stream: transformedBody.stream,
            templateInjectionEnabled: !!injectionConfig.enableChatTemplateKwargs,
            injectedKeys: [
                ...Object.keys(injectionConfig.parameters || {}),
                injectionConfig.enableChatTemplateKwargs ? 'chat_template_kwargs' : null
            ].filter(Boolean)
        });

        return transformedBody;
    }
}