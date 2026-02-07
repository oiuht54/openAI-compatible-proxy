***

# OpenAI Compatible Proxy Middleware

**Enterprise-grade OpenAI compatible proxy for parameter injection, monitoring, and request resilience.**

This middleware acts as a bridge between your AI clients (like Chat WebUIs, IDE plugins, or scripts) and upstream OpenAI-compatible APIs (OpenAI, Azure, NVIDIA NIM, vLLM, etc.). It provides real-time monitoring, automatic parameter injection (e.g., forcing specific temperatures or "thinking" parameters), and a robust Circuit Breaker system to handle upstream failures.

---

## 🇬🇧 English Documentation

### Key Features

*   **🕵️‍♂️ Deep Parameter Injection:** Automatically inject parameters into every request.
    *   Force model overrides.
    *   Inject `temperature`, `top_p`, and other generation settings.
    *   **Thinking Support:** Specifically handles `chat_template_kwargs` to enable "thinking" capabilities on supported models (e.g., via NVIDIA NIM).
*   **📊 Real-time Dashboard:** Built-in web interface to monitor traffic.
    *   View active, successful, and failed requests.
    *   Inspect full request/response payloads (including "Thinking/Reasoning" content).
    *   Track Circuit Breaker status.
*   **🛡️ Resilience Patterns:**
    *   **Circuit Breaker:** Automatically stops traffic to a failing upstream to prevent cascading failures.
    *   **Retry Mechanism:** Exponential backoff retries for transient network errors.
*   **⚡ Hot Reload:** Modify `config.json` on the fly without restarting the server.
*   **📝 Logging & Tracing:** Detailed request logging using `pino`, with sensitive data (API Keys) redacted.
*   **✅ Validation:** Strict request validation using `Zod` to ensure payload integrity before it hits the upstream.

### Installation

1.  **Prerequisites:** Node.js >= 18.0.0.
2.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/openai-proxy-middleware.git
    cd openai-proxy-middleware
    ```
3.  **Install dependencies:**
    ```bash
    npm install
    ```

### Configuration

The application is controlled via `config.json` (or `src/config.json`). The server watches this file and reloads changes automatically.

```json
{
  "server": {
    "port": 7848,
    "host": "0.0.0.0"
  },
  "upstream": {
    "url": "///",
    "timeoutMs": 180000,
    "apiKey": "sk-your-upstream-api-key"
  },
  "injection": {
    "forceModel": "optional-model-override-name",
    "enableChatTemplateKwargs": true,
    "parameters": {
      "temperature": 1,
      "top_p": 0.98
    },
    "chatTemplateKwargs": {
      "thinking": true
    }
  }
}
```

| Section | Key | Description |
| :--- | :--- | :--- |
| **server** | `port` | The port the proxy listens on (Default: `7848`). |
| **upstream** | `url` | The base URL of the actual API provider (e.g., NVIDIA, OpenAI). |
| | `timeoutMs` | Request timeout in milliseconds. |
| | `apiKey` | (Optional) Hardcode the Upstream API key here. If omitted, the proxy forwards the key sent by the client. |
| **injection** | `forceModel` | If set, overrides the `model` field in the client's request. |
| | `parameters` | Key-value pairs merged into the request body (e.g., temperature). |
| | `chatTemplateKwargs`| Special object for "Thinking" models (NVIDIA/vLLM style). |

### Usage

1.  **Start the server:**
    ```bash
    npm start
    ```
2.  **Connect your Client:**
    Point your AI client (SillyTavern, VS Code, etc.) to:
    *   **Base URL:** `http://localhost:7848/v1`
    *   **API Key:** (Any string if configured in `config.json`, otherwise your actual provider key).

### Dashboard

Access the monitoring dashboard at:
**`http://localhost:7848/dashboard`**

Here you can:
*   See live request stats (Success/Fail/Timeout).
*   Reset statistics.
*   Click on specific requests to see the **Thoughts/Reasoning** separate from the final response content.

---

## 🇷🇺 Документация на Русском

**Прокси-сервер промышленного уровня, совместимый с OpenAI API, для инъекции параметров, мониторинга и обеспечения устойчивости запросов.**

Это промежуточное ПО (Middleware) работает как мост между вашими AI-клиентами и API провайдера (OpenAI, NVIDIA NIM, vLLM и т.д.). Оно обеспечивает мониторинг в реальном времени, принудительное добавление параметров генерации и защиту от сбоев на стороне провайдера.

### Основные возможности

*   **🕵️‍♂️ Инъекция параметров:** Автоматическое изменение тела запроса.
    *   Принудительная подмена модели (`forceModel`).
    *   Установка `temperature`, `top_p` и других настроек.
    *   **Поддержка "Thinking":** Специальная обработка `chat_template_kwargs` для включения режима "мышления" на поддерживаемых моделях (например, через NVIDIA NIM).
*   **📊 Дашборд в реальном времени:** Встроенный веб-интерфейс.
    *   Статистика запросов (Успешные/Ошибки/Таймауты).
    *   Детальный просмотр "мыслей" (Chain of Thought) и финального ответа.
    *   Статус Circuit Breaker (предохранителя).
*   **🛡️ Отказоустойчивость:**
    *   **Circuit Breaker:** Блокирует запросы к "упавшему" API, чтобы предотвратить каскадные сбои.
    *   **Smart Retry:** Повторные попытки запросов с экспоненциальной задержкой при сетевых ошибках.
*   **⚡ Горячая перезагрузка:** Изменения в `config.json` применяются мгновенно без перезапуска процесса.
*   **📝 Логирование:** Подробные логи через `pino` с автоматическим скрытием API-ключей.

### Установка

1.  **Требования:** Node.js версии 18.0.0 или выше.
2.  **Клонирование репозитория:**
    ```bash
    git clone https://github.com/your-username/openai-proxy-middleware.git
    cd openai-proxy-middleware
    ```
3.  **Установка зависимостей:**
    ```bash
    npm install
    ```

### Настройка

Все настройки находятся в файле `config.json`. Сервер отслеживает изменения в этом файле.

```json
{
  "server": {
    "port": 7848,
    "host": "0.0.0.0"
  },
  "upstream": {
    "url": "///",
    "timeoutMs": 180000,
    "apiKey": "sk-ваш-ключ-от-провайдера"
  },
  "injection": {
    "forceModel": "имя-модели-для-подмены",
    "enableChatTemplateKwargs": true,
    "parameters": {
      "temperature": 1,
      "top_p": 0.98
    },
    "chatTemplateKwargs": {
      "thinking": true
    }
  }
}
```

| Секция | Параметр | Описание |
| :--- | :--- | :--- |
| **server** | `port` | Порт прокси-сервера (По умолчанию: `7848`). |
| **upstream** | `url` | URL провайдера API (без `/chat/completions`). |
| | `timeoutMs` | Таймаут ожидания ответа в миллисекундах. |
| | `apiKey` | (Опционально) Ключ API. Если не указан, прокси перешлет ключ клиента. |
| **injection** | `forceModel` | Если заполнено, подменяет модель в запросе клиента на указанную. |
| | `parameters` | Параметры, добавляемые в тело запроса (температура и т.д.). |
| | `chatTemplateKwargs`| Объект для специфичных настроек (например, для активации Thinking). |

### Использование

1.  **Запуск сервера:**
    ```bash
    npm start
    ```
2.  **Подключение клиента:**
    Настройте ваш чат-бот или IDE на использование прокси:
    *   **Base URL:** `http://localhost:7848/v1`
    *   **API Key:** (Любой, если задан в конфиге, либо ваш реальный ключ).

### Мониторинг (Dashboard)

Откройте в браузере:
**`http://localhost:7848/dashboard`**

Возможности дашборда:
*   Просмотр текущего аптайма и статистики.
*   Таблица последних запросов с возможностью фильтрации.
*   При клике на запрос открывается модальное окно, где **Thoughts (Мысли)** и *
