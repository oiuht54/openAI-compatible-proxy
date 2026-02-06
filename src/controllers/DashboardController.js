import { metricsService } from '../services/MetricsService.js';
import { LoggerService } from '../utils/Logger.js';
import { ProxyService } from '../services/ProxyService.js';

export class DashboardController {
  /**
   * Получить статистику прокси
   */
  static async getStats(req, res) {
    try {
      const stats = metricsService.getStats();
      res.json(stats);
    } catch (error) {
      LoggerService.error('Dashboard stats error', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }

  /**
   * Получить последние запросы
   */
  static async getRequests(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const status = req.query.status;
      const method = req.query.method;
      const minDuration = req.query.minDuration ? parseInt(req.query.minDuration) : undefined;
      const model = req.query.model;
      const stream = req.query.stream === 'true' ? true : req.query.stream === 'false' ? false : undefined;

      const filter = { status, method, minDuration, model, stream };
      
      // Удаляем undefined значения
      Object.keys(filter).forEach(key => filter[key] === undefined && delete filter[key]);

      const requests = metricsService.getRecentRequests(limit, filter);
      res.json({ requests, total: requests.length });
    } catch (error) {
      LoggerService.error('Dashboard requests error', error);
      res.status(500).json({ error: 'Failed to get requests' });
    }
  }

  /**
   * Получить конкретный запрос по ID
   */
  static async getRequest(req, res) {
    try {
      const { id } = req.params;
      const request = metricsService.getRequest(id);
      
      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json(request);
    } catch (error) {
      LoggerService.error('Dashboard request detail error', error);
      res.status(500).json({ error: 'Failed to get request detail' });
    }
  }

  /**
   * Получить статус Circuit Breaker
   */
  static async getCircuitBreakerStatus(req, res) {
    try {
      const status = ProxyService.getCircuitBreakerStatus();
      res.json(status);
    } catch (error) {
      LoggerService.error('Dashboard circuit breaker error', error);
      res.status(500).json({ error: 'Failed to get circuit breaker status' });
    }
  }

  /**
   * Сбросить статистику
   */
  static async resetStats(req, res) {
    try {
      metricsService.resetCounters();
      res.json({ success: true, message: 'Statistics reset successfully' });
    } catch (error) {
      LoggerService.error('Dashboard reset error', error);
      res.status(500).json({ error: 'Failed to reset stats' });
    }
  }

  /**
   * Очистить все данные (запросы и статистику)
   */
  static async clearAll(req, res) {
    try {
      metricsService.clearAll();
      res.json({ success: true, message: 'All data cleared successfully' });
    } catch (error) {
      LoggerService.error('Dashboard clear error', error);
      res.status(500).json({ error: 'Failed to clear data' });
    }
  }

  /**
   * Serve HTML страницу дашборда
   */
  static serveDashboard(req, res) {
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenAI Proxy Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #e0e0e0;
            min-height: 100vh;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            margin-bottom: 30px;
        }
        h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            background: linear-gradient(90deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
        }
        .stat-card h3 {
            font-size: 0.9rem;
            color: #888;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .stat-card .value {
            font-size: 2rem;
            font-weight: bold;
        }
        .stat-card.success .value { color: #4ade80; }
        .stat-card.error .value { color: #f87171; }
        .stat-card.warning .value { color: #fbbf24; }
        .stat-card.info .value { color: #60a5fa; }
        .section {
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .section h2 {
            margin-bottom: 20px;
            font-size: 1.5rem;
        }
        .circuit-breaker {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        .cb-status {
            padding: 10px 20px;
            border-radius: 20px;
            font-weight: bold;
        }
        .cb-status.CLOSED { background: #4ade80; color: #000; }
        .cb-status.OPEN { background: #f87171; color: #000; }
        .cb-status.HALF_OPEN { background: #fbbf24; color: #000; }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        th {
            background: rgba(255,255,255,0.1);
            font-weight: 600;
        }
        .status-badge {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: bold;
        }
        .status-success { background: #4ade80; color: #000; }
        .status-error { background: #f87171; color: #000; }
        .status-pending { background: #fbbf24; color: #000; }
        .filters {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .filters select, .filters input {
            padding: 10px 15px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.1);
            color: #fff;
            cursor: pointer;
        }
        .filters button {
            padding: 10px 20px;
            border-radius: 8px;
            border: none;
            background: linear-gradient(90deg, #667eea, #764ba2);
            color: #fff;
            cursor: pointer;
            font-weight: 600;
        }
        .time {
            font-family: monospace;
            color: #888;
        }
        .stream-badge {
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.7rem;
            font-weight: bold;
        }
        .stream-true { background: #60a5fa; color: #000; }
        .stream-false { background: #4b5563; color: #fff; }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.8);
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .modal.active { display: flex; }
        .modal-content {
            background: #1a1a2e;
            border-radius: 12px;
            padding: 30px;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            width: 90%;
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .close-modal {
            background: none;
            border: none;
            color: #fff;
            font-size: 2rem;
            cursor: pointer;
        }
        .json-display {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 8px;
            overflow-x: auto;
            font-family: monospace;
            font-size: 0.9rem;
        }
        .refresh-btn {
            padding: 20px;
            width: 100%;
            border: none;
            border-radius: 8px;
            background: linear-gradient(90deg, #667eea, #764ba2);
            color: #fff;
            cursor: pointer;
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 20px;
        }
        .actions {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            justify-content: flex-end;
        }
        .actions button {
            padding: 8px 15px;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            font-weight: 600;
        }
        .btn-danger { background: #f87171; color: #000; }
        .btn-warning { background: #fbbf24; color: #000; }

        /* Meta Section */
        .meta-section {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            margin-bottom: 20px;
            padding: 10px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .meta-section.open > summary {
            display: none;
        }
        .meta-section summary {
            cursor: pointer;
            font-weight: 600;
            color: #888;
            user-select: none;
            padding: 8px;
        }
        .meta-section summary:hover {
            color: #ccc;
        }
        .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 10px;
            padding: 10px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 6px;
        }
        .meta-grid div {
            font-size: 0.85rem;
        }
        .meta-grid strong {
            color: #888;
        }

        /* Section Headers */
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .section-header h3 {
            margin: 0;
            font-size: 1.1rem;
            font-weight: 600;
        }
        .section.thoughts-section .section-header h3 {
            color: #c4b5fd;
        }
        .section.response-section .section-header h3 {
            color: #4ade80;
        }
        .section.error-section .section-header h3 {
            color: #f87171;
        }

        /* Copy Button */
        .copy-btn {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            border-radius: 6px;
            padding: 6px 12px;
            cursor: pointer;
            color: #fff;
            font-size: 0.85rem;
            transition: all 0.2s;
        }
        .copy-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: scale(1.05);
        }
        .copy-btn:active {
            transform: scale(0.95);
        }

        /* Content Blocks */
        .content-block {
            background: rgba(0, 0, 0, 0.3);
            padding: 15px;
            border-radius: 8px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.6;
            max-height: 500px;
            overflow-y: auto;
            font-size: 0.9rem;
        }
        .content-block::-webkit-scrollbar {
            width: 8px;
        }
        .content-block::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
        }
        .content-block::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }
        .content-block::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        /* Thoughts Section Styles */
        .thoughts-section {
            background: rgba(139, 92, 246, 0.08);
            border-left: 4px solid #8b5cf6;
            padding: 15px;
            border-radius: 0 8px 8px 0;
        }
        .thoughts-content {
            color: #c4b5fd;
            background: rgba(139, 92, 246, 0.1);
        }
        .thoughts-content th { color: #ddd; background: rgba(139, 92, 246, 0.2); }

        /* Response Section Styles */
        .response-section {
            background: rgba(74, 222, 128, 0.05);
            border-left: 4px solid #4ade80;
            padding: 15px;
            border-radius: 0 8px 8px 0;
        }
        .response-content {
            color: #e0e0e0;
            background: rgba(0, 0, 0, 0.3);
        }
        .response-content th { color: #ddd; background: rgba(74, 222, 128, 0.15); }

        /* Error Section Styles */
        .error-section {
            background: rgba(248, 113, 113, 0.08);
            border-left: 4px solid #f87171;
            padding: 15px;
            border-radius: 0 8px 8px 0;
        }
        .error-content {
            color: #fca5a5;
            background: rgba(248, 113, 113, 0.1);
        }

        /* Markdown Body Styles */
        .markdown-body {
            display: block;
        }
        .markdown-body p {
            margin: 0 0 10px 0;
        }
        .markdown-body p:last-child {
            margin-bottom: 0;
        }
        .markdown-body strong {
            color: #fff;
            font-weight: 700;
        }
        .markdown-body em {
            color: #bbb;
            font-style: italic;
        }
        .markdown-body code {
            background: rgba(255, 255, 255, 0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 0.85em;
            color: #fbbf24;
        }
        .markdown-body pre {
            background: rgba(0, 0, 0, 0.4);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 10px 0;
        }
        .markdown-body pre code {
            background: none;
            padding: 0;
            color: #e0e0e0;
            font-size: 0.9em;
        }
        .markdown-body ul, .markdown-body ol {
            margin: 8px 0;
            padding-left: 24px;
        }
        .markdown-body li {
            margin: 4px 0;
        }
        .markdown-body a {
            color: #60a5fa;
            text-decoration: underline;
        }
        .markdown-body a:hover {
            color: #93c5fd;
        }
        .markdown-body blockquote {
            border-left: 3px solid #667eea;
            padding-left: 12px;
            margin: 10px 0;
            color: #999;
            font-style: italic;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 {
            margin: 15px 0 8px 0;
            color: #fff;
        }
        .markdown-body h1 { font-size: 1.4em; }
        .markdown-body h2 { font-size: 1.25em; }
        .markdown-body h3 { font-size: 1.1em; }
        .markdown-body hr {
            border: none;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            margin: 15px 0;
        }
        .markdown-body table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
        }
        .markdown-body th, .markdown-body td {
            padding: 8px 12px;
            text-align: left;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .markdown-body th {
            font-weight: 600;
        }
        .markdown-body tr:nth-child(even) {
            background: rgba(255, 255, 255, 0.03);
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🚀 OpenAI Proxy Dashboard</h1>
            <p>Мониторинг и трассировка запросов в реальном времени</p>
        </header>
        
        <button class="refresh-btn" onclick="loadData()">🔄 Обновить данные</button>
        
        <div class="stats-grid" id="stats-grid">
            <!-- Stats will be loaded here -->
        </div>
        
        <div class="section">
            <h2>⚡ Circuit Breaker Status</h2>
            <div class="circuit-breaker" id="circuit-breaker">
                <!-- Circuit breaker status will be loaded here -->
            </div>
        </div>
        
        <div class="section">
            <h2>📊 Последние запросы</h2>
            <div class="filters">
                <select id="filter-status" onchange="loadRequests()">
                    <option value="">Все статусы</option>
                    <option value="success">Успешные</option>
                    <option value="error">С ошибкой</option>
                    <option value="pending">В ожидании</option>
                </select>
                <select id="filter-stream" onchange="loadRequests()">
                    <option value="">Все типы</option>
                    <option value="true">Stream</option>
                    <option value="false">Non-stream</option>
                </select>
                <input type="number" id="filter-min-duration" placeholder="Мин. длительность (ms)" onchange="loadRequests()">
            </div>
            <table>
                <thead>
                    <tr>
                        <th style="width:120px">Время</th>
                        <th style="width:60px">Метод</th>
                        <th style="width:120px">Модель</th>
                        <th style="width:60px">Статус</th>
                        <th style="width:80px">Длит.</th>
                        <th style="width:60px">Tht.</th>
                        <th>Response Preview</th>
                        <th style="width:60px">Дет.</th>
                    </tr>
                </thead>
                <tbody id="requests-table">
                    <!-- Requests will be loaded here -->
                </tbody>
            </table>
        </div>
        
        <div class="actions">
            <button class="btn-warning" onclick="resetStats()">Сбросить статистику</button>
            <button class="btn-danger" onclick="clearAll()">Очистить всё</button>
        </div>
    </div>
    
    <div class="modal" id="detail-modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Детали запроса #<span id="req-id"></span></h2>
                <button class="close-modal" onclick="closeModal()">&times;</button>
            </div>

            <!-- Meta Section (сворачиваемый) -->
            <details class="meta-section open">
                <summary>📊 Метаданные</summary>
                <div class="meta-grid">
                    <div><strong>Время:</strong> <span id="meta-time">-</span></div>
                    <div><strong>Модель:</strong> <span id="meta-model">-</span></div>
                    <div><strong>Статус:</strong> <span id="meta-status">-</span></div>
                    <div><strong>Длительность:</strong> <span id="meta-duration">-</span></div>
                    <div><strong>Stream:</strong> <span id="meta-stream">-</span></div>
                    <div><strong>Upstream:</strong> <span id="meta-upstream">-</span></div>
                </div>
            </details>

            <!-- Thoughts Section -->
            <div class="section thoughts-section" id="thoughts-container" style="display:none">
                <div class="section-header">
                    <h3>🧠 Thoughts / Reasoning</h3>
                    <button class="copy-btn" onclick="copyContent('thoughts')" title="Копировать">📋</button>
                </div>
                <div class="content-block thoughts-content" id="thoughts-content"></div>
            </div>

            <!-- Response Section -->
            <div class="section response-section">
                <div class="section-header">
                    <h3>💬 Response</h3>
                    <button class="copy-btn" onclick="copyContent('response')" title="Копировать">📋</button>
                </div>
                <div class="content-block response-content" id="response-content"></div>
            </div>

            <!-- Error Section -->
            <div class="section error-section" id="error-container" style="display:none">
                <div class="section-header">
                    <h3>❌ Error</h3>
                </div>
                <div class="content-block error-content" id="error-content"></div>
            </div>
        </div>
    </div>
    
    <script>
        const API_BASE = '/api/dashboard';
        
        async function loadData() {
            await loadStats();
            await loadCircuitBreaker();
            await loadRequests();
        }
        
        async function loadStats() {
            try {
                const res = await fetch(\`\${API_BASE}/stats\`);
                const data = await res.json();
                renderStats(data);
            } catch (error) {
                console.error('Failed to load stats:', error);
            }
        }
        
        function renderStats(data) {
            const grid = document.getElementById('stats-grid');
            const uptime = formatDuration(data.uptime);
            
            grid.innerHTML = \`
                <div class="stat-card info">
                    <h3>Аптайм</h3>
                    <div class="value">\${uptime}</div>
                </div>
                <div class="stat-card info">
                    <h3>Всего запросов</h3>
                    <div class="value">\${data.counters.totalRequests}</div>
                </div>
                <div class="stat-card success">
                    <h3>Успешных</h3>
                    <div class="value">\${data.counters.successfulRequests}</div>
                </div>
                <div class="stat-card error">
                    <h3>С ошибкой</h3>
                    <div class="value">\${data.counters.failedRequests}</div>
                </div>
                <div class="stat-card warning">
                    <h3>Timeout</h3>
                    <div class="value">\${data.counters.timeoutRequests}</div>
                </div>
                <div class="stat-card warning">
                    <h3>CB блокировок</h3>
                    <div class="value">\${data.counters.circuitBreakerBlocked}</div>
                </div>
            \`;
        }
        
        async function loadCircuitBreaker() {
            try {
                const res = await fetch(\`\${API_BASE}/circuit-breaker\`);
                const data = await res.json();
                renderCircuitBreaker(data);
            } catch (error) {
                console.error('Failed to load circuit breaker:', error);
            }
        }
        
        function renderCircuitBreaker(data) {
            const container = document.getElementById('circuit-breaker');
            const nextAttempt = data.nextAttemptTime > 0 
                ? \`\${(data.nextAttemptTime / 1000).toFixed(1)}s\` 
                : '-';
            
            container.innerHTML = \`
                <div class="cb-status \${data.state}">\${data.state}</div>
                <div>
                    <div>Провалов: <strong>\${data.failureCount}</strong></div>
                    <div>До следующей попытки: <strong>\${nextAttempt}</strong></div>
                </div>
            \`;
        }
        
        async function loadRequests() {
            try {
                const status = document.getElementById('filter-status').value;
                const stream = document.getElementById('filter-stream').value;
                const minDuration = document.getElementById('filter-min-duration').value;
                
                const params = new URLSearchParams({
                    limit: '50',
                    ...(status && { status }),
                    ...(stream && { stream }),
                    ...(minDuration && { minDuration }),
                });
                
                const res = await fetch(\`\${API_BASE}/requests?\${params}\`);
                const data = await res.json();
                renderRequests(data.requests);
            } catch (error) {
                console.error('Failed to load requests:', error);
            }
        }
        
        function renderRequests(requests) {
            const tbody = document.getElementById('requests-table');
            
            if (requests.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px">Нет запросов</td></tr>';
                return;
            }
            
            tbody.innerHTML = requests.map(req => {
                const hasThoughts = req.responsePreview?.hasThoughts || false;
                const responsePreview = req.responsePreview?.responsePreview || '-';
                
                return \`
                    <tr>
                        <td class="time">\${new Date(req.timestamp).toLocaleTimeString()}</td>
                        <td>\${req.method}</td>
                        <td style="font-size:0.85rem">\${req.model || '-'}</td>
                        <td><span class="status-badge status-\${req.status}">\${req.status}</span></td>
                        <td style="font-size:0.85rem">\${req.durationMs ? \`\${req.durationMs}ms\` : '-'}</td>
                        <td style="font-size:1.2rem;text-align:center" title="\${hasThoughts ? 'Есть Thoughts' : ''}">\${hasThoughts ? '🧠' : ''}</td>
                        <td style="font-size:0.75rem;color:#aaa;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${escapeHtml(responsePreview)}">\${escapeHtml(responsePreview)}</td>
                        <td><button onclick="showDetail('\${req.id}')" style="padding:4px 10px;border-radius:6px;border:none;background:#667eea;color:#fff;cursor:pointer;font-size:0.8rem">✓️</button></td>
                    </tr>
                \`;
            }).join('');
        }

        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        async function showDetail(id) {
            try {
                const res = await fetch(\`\${API_BASE}/requests/\${id}\`);
                const req = await res.json();
                
                // Meta
                document.getElementById('req-id').textContent = req.id;
                document.getElementById('meta-time').textContent = new Date(req.timestamp).toLocaleString();
                document.getElementById('meta-model').textContent = req.model || '-';
                document.getElementById('meta-status').textContent = req.status;
                document.getElementById('meta-duration').textContent = req.durationMs ? \`\${req.durationMs}ms\` : '-';
                document.getElementById('meta-stream').textContent = req.stream ? 'Yes' : 'No';
                document.getElementById('meta-upstream').textContent = req.upstreamStatus || '-';

                // Thoughts
                const thoughtsContainer = document.getElementById('thoughts-container');
                const thoughtsContent = document.getElementById('thoughts-content');
                if (req.responsePreview?.hasThoughts && req.responsePreview.thoughts) {
                    thoughtsContainer.style.display = 'block';
                    thoughtsContent.textContent = req.responsePreview.thoughts;
                } else {
                    thoughtsContainer.style.display = 'none';
                }

                // Response
                const responseContent = document.getElementById('response-content');
                const responseText = req.responsePreview?.response || '(нет ответа)';
                responseContent.textContent = responseText;

                // Error (если есть)
                const errorContainer = document.getElementById('error-container');
                const errorContent = document.getElementById('error-content');
                if (req.errorMessage) {
                    errorContainer.style.display = 'block';
                    errorContent.textContent = req.errorMessage;
                } else {
                    errorContainer.style.display = 'none';
                }

                document.getElementById('detail-modal').classList.add('active');
            } catch (error) {
                console.error('Failed to load request detail:', error);
                alert('Ошибка загрузки деталей запроса');
            }
        }

        // Простая парсерка Markdown - убрана для avoiding escaping issues
        function formatText(text) {
            if (!text) return '';
            return escapeHtml(text);
        }

        function copyContent(type) {
            const element = document.getElementById(type + '-content');
            const text = element.textContent.trim();
            
            navigator.clipboard.writeText(text).then(() => {
                // Визуальная индикация
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✅';
                setTimeout(() => {
                    btn.textContent = originalText;
                }, 1000);
            }).catch(err => {
                console.error('Не удалось скопировать:', err);
                alert('Ошибка копирования в буфер обмена');
            });
        }
        
        function closeModal() {
            document.getElementById('detail-modal').classList.remove('active');
        }
        
        async function resetStats() {
            if (!confirm('Сбросить статистику?')) return;
            
            try {
                const res = await fetch(\`\${API_BASE}/reset\`, { method: 'POST' });
                if (res.ok) loadData();
            } catch (error) {
                alert('Ошибка сброса статистики');
            }
        }
        
        async function clearAll() {
            if (!confirm('Очистить все данные? Это действие необратимо.')) return;
            
            try {
                const res = await fetch(\`\${API_BASE}/clear\`, { method: 'POST' });
                if (res.ok) loadData();
            } catch (error) {
                alert('Ошибка очистки данных');
            }
        }
        
        function formatDuration(ms) {
            if (ms < 1000) return \`\${ms}ms\`;
            if (ms < 60000) return \`\${(ms / 1000).toFixed(1)}s\`;
            const minutes = Math.floor(ms / 60000);
            const seconds = Math.floor((ms % 60000) / 1000);
            return \`\${minutes}m \${seconds}s\`;
        }
        
        // Initial load
        loadData();
        
        // Auto-refresh every 5 seconds
        setInterval(loadData, 5000);
        
        // Close modal on outside click
        document.getElementById('detail-modal').addEventListener('click', (e) => {
            if (e.target.id === 'detail-modal') closeModal();
        });
    </script>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
