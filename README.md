# OpenAI Compatible Proxy

Enterprise-grade OpenAI compatible proxy for parameter injection with monitoring.

## Features

- 🔄 **OpenAI API Compatible**: Drop-in replacement for OpenAI API endpoints
- 🎯 **Parameter Injection**: Force model overrides and inject custom parameters
- 📊 **Built-in Dashboard**: Real-time monitoring and request tracing
- 🛡️ **Circuit Breaker**: Protection against cascading failures
- ⚡ **Streaming Support**: Full SSE streaming support with heartbeat
- 🔍 **Metrics & Logging**: Comprehensive request tracking
- 🎨 **Thinking/Reasoning Support**: Display model's thought process

## Installation

```bash
npm install
```

## Configuration

Copy `config.example.json` to `config.json`:

```bash
cp config.example.json config.json
```

Edit `config.json` to match your setup:

```json
{
  "server": {
    "port": 7848,
    "host": "0.0.0.0"
  },
  "upstream": {
    "url": "http://your-llm-server:8000/v1",
    "timeoutMs": 180000,
    "firstTokenTimeoutMs": 20000,
    "firstTokenRetryAttempts": 2,
    "streamFallbackTimeoutMs": 180000,
    "apiKey": "sk-your-upstream-api-key",
    "streamHeartbeatEnabled": true,
    "streamHeartbeatIntervalMs": 30000,
    "streamHeartbeatMessage": ":keep-alive"
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

## Configuration Options

### Server

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `7848` | Port to listen on |
| `host` | string | `"0.0.0.0"` | Host to bind to |

### Upstream

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | *required* | Upstream API URL |
| `timeoutMs` | number | `3600000` | Overall request timeout (ms, default: 60 minutes) |
| `firstTokenTimeoutMs` | number | `60000` | Timeout for first streaming token (ms, default: 60 seconds) |
| `firstTokenRetryAttempts` | number | `2` | Number of retries on first token timeout |
| `streamFallbackTimeoutMs` | number | `3600000` | Fallback timeout for streaming requests (ms, default: 60 minutes) |
| `apiKey` | string | *optional* | API key for upstream authentication |
| `streamHeartbeatEnabled` | boolean | `true` | Enable SSE heartbeat for streaming |
| `streamHeartbeatIntervalMs` | number | `30000` | Heartbeat interval (ms) |
| `streamHeartbeatMessage` | string | `":keep-alive"` | Heartbeat message |

### Injection

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `forceModel` | string | *optional* | Override model name for all requests |
| `enableChatTemplateKwargs` | boolean | `true` | Enable chat_template_kwargs injection |
| `parameters` | object | `{}` | Parameters to inject (temperature, top_p, etc.) |
| `chatTemplateKwargs` | object | `{}` | Chat template kwargs to inject |

## Usage

### Start the server

```bash
npm start
```

### Using with OpenAI clients

Set the base URL to your proxy:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:7848/v1",
    api_key="any-key"  # Proxy validates with upstream key
)

response = client.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:7848/v1',
  apiKey: 'any-key',
});

const response = await client.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### cURL example

```bash
curl -X POST http://localhost:7848/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Dashboard

Access the monitoring dashboard at:

```
http://localhost:7848/
```

The dashboard shows:
- Request statistics (total, successful, failed, timeouts)
- Circuit breaker status
- Recent requests with filtering
- Detailed request information including thoughts/reasoning

## Hot Reload

Configuration changes are automatically detected and applied. Simply save `config.json` to update the proxy settings.

## API Endpoints

### Proxy Endpoints

- `POST /v1/chat/completions` - OpenAI-compatible chat completions
- `POST /chat/completions` - Chat completions without `/v1` prefix
- `GET /health` - Health check

### Dashboard Endpoints

- `GET /` - Dashboard UI
- `GET /api/dashboard/stats` - Get statistics
- `GET /api/dashboard/requests` - Get recent requests
- `GET /api/dashboard/requests/:id` - Get specific request details
- `GET /api/dashboard/circuit-breaker` - Get circuit breaker status
- `POST /api/dashboard/reset` - Reset statistics
- `POST /api/dashboard/clear` - Clear all data

## Recent Fixes (v2.1.0)

This update addresses critical issues that caused the proxy to hang and accumulate stuck requests:

### 🔧 Fixed Issues

1. **Resource Leaks in Streaming Requests**
   - Fixed cleanup function not being called in all code paths
   - Added guaranteed cleanup in try/catch/finally blocks
   - Implemented fallback timeout for stuck streaming connections

2. **Retry Logic Problems**
   - Fixed abort controllers not being properly cleaned up during retries
   - Fixed buffered streams not being destroyed correctly on retry
   - Fixed event handlers not being removed before retry attempts

3. **HeartbeatStream Cleanup**
   - Added forced destruction method for heartbeat streams
   - Fixed heartbeat timers not stopping on errors
   - Improved error handling in heartbeat callbacks

4. **Streaming Error Handling**
   - Added fallback timeout mechanism for stuck streams
   - Added handlers for 'close' and 'finish' events
   - Improved cleanup guarantees across all error scenarios

5. **Non-streaming Timeouts**
   - Added proper timeout handling for non-streaming requests
   - Synchronized axios timeout with request timeout
   - Improved AbortError handling

6. **Metrics Service Memory Leaks**
   - Added automatic cleanup of stale pending requests (every 60s)
   - Requests older than 5 minutes in 'pending' state are auto-removed
   - Added destroy method for proper shutdown

7. **HTTP Agent Configuration**
   - Increased `maxSockets` from 50 to 100 for better concurrency
   - Added proper `keepAliveMsecs` configuration
   - Removed conflicting timeout settings

8. **Server Timeout Configuration**
   - Increased `keepAliveTimeout` to 2 hours (7200000ms) for long-lived streaming connections
   - Added `requestTimeout` (60 minutes) for very slow models
   - Optimized `headersTimeout` to match keepAliveTimeout

### 🆕 New Features

- Added `streamFallbackTimeoutMs` configuration option
- Automatic stale request cleanup in MetricsService
- Improved logging for debugging connection issues

### ⚙️ Configuration Changes

New default configuration:
- `timeoutMs`: 3600000 (60 minutes - for very slow models)
- `firstTokenTimeoutMs`: 60000 (60 seconds - increased from 20000)
- `streamFallbackTimeoutMs`: 3600000 (60 minutes - new option)
- `streamHeartbeatEnabled`: true (now default)
- `streamHeartbeatIntervalMs`: 30000

### 🐛 Bug Fixes

- Fixed memory leaks from dangling event handlers
- Fixed stream completion detection
- Fixed circuit breaker state management
- Fixed metrics collection for error cases

## Troubleshooting

### Request hangs without response

1. Check the dashboard for pending requests
2. Verify upstream server is responsive
3. Adjust `firstTokenTimeoutMs` if upstream is slow to start (default: 60s)
4. Adjust `timeoutMs` and `streamFallbackTimeoutMs` for long-running requests (default: 60 minutes)
5. Check logs for timeout errors

### Circuit breaker keeps opening

1. Check upstream server health
2. Adjust `firstTokenRetryAttempts` and `firstTokenTimeoutMs`
3. Verify network connectivity to upstream

### Memory usage increasing

1. Check dashboard for pending requests
2. Enable log level debug for more information
3. Consider reducing `maxSockets` in agent configuration

## License

MIT
