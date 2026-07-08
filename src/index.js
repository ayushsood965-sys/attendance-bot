require('dotenv').config();

// Dynamically patch puppeteer-real-browser to redirect chromium stdout/stderr to files
try {
  const fs = require('fs');
  const path = require('path');
  const libPath = path.join(__dirname, '../node_modules/puppeteer-real-browser/lib/cjs/index.js');
  if (fs.existsSync(libPath)) {
    let content = fs.readFileSync(libPath, 'utf8');
    const regex = /const chrome = await launch\([\s\S]*?\}\);/;
    const match = content.match(regex);
    if (match && !content.includes('chrome-stdout.log')) {
      const replacement = match[0] + `
  if (chrome.process) {
    const fs = require('fs');
    if (chrome.process.stdout) {
      const outLog = fs.createWriteStream('/app/chrome-stdout.log', { flags: 'a' });
      chrome.process.stdout.pipe(outLog);
    }
    if (chrome.process.stderr) {
      const errLog = fs.createWriteStream('/app/chrome-stderr.log', { flags: 'a' });
      chrome.process.stderr.pipe(errLog);
    }
  }`;
      content = content.replace(regex, replacement);
      fs.writeFileSync(libPath, content, 'utf8');
      console.log('Successfully patched puppeteer-real-browser to dump chromium stdout/stderr!');
    }
  }
} catch (e) {
  console.error('Failed to patch puppeteer-real-browser:', e);
}

const config = require('./config');
const logger = require('./logger');
const { startScheduler, executeTask } = require('./scheduler');
const { closeBrowser } = require('./browser');

// Start a simple HTTP health check server on Linux to satisfy Coolify/Traefik routing checks
if (process.platform === 'linux') {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');

  let isRunInProgress = false;
  let runError = null;
  let currentShift = 'morning';

  http.createServer(async (req, res) => {
    if (req.url === '/diagnostics') {
      try {
        const filePath = '/app/diagnostics.log';
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fs.readFileSync(filePath, 'utf8'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Diagnostics log not found yet');
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/status') {
      try {
        const cp = require('child_process');
        const processes = cp.execSync('ps aux 2>&1 || ps -ef 2>&1').toString();
        const tmpFiles = cp.execSync('ls -la /tmp /tmp/.X11-unix 2>&1').toString();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Processes:\n${processes}\n\nFiles:\n${tmpFiles}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/chrome-log') {
      try {
        const tmpDirs = fs.readdirSync('/tmp');
        const lhDirs = tmpDirs.filter(d => d.startsWith('lighthouse.'));
        let logContent = '';
        for (const dir of lhDirs) {
          const logPath = path.join('/tmp', dir, 'chrome-err.log');
          if (fs.existsSync(logPath)) {
            logContent += `=== ${dir}/chrome-err.log ===\n${fs.readFileSync(logPath, 'utf8')}\n\n`;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(logContent || 'No chrome-err.log found');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/chrome-stdout') {
      try {
        const filePath = '/app/chrome-stdout.log';
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fs.readFileSync(filePath, 'utf8'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('No chrome-stdout.log found');
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/chrome-stderr') {
      try {
        const filePath = '/app/chrome-stderr.log';
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fs.readFileSync(filePath, 'utf8'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('No chrome-stderr.log found');
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url.startsWith('/run-bot') && !req.url.includes('/status') && !req.url.includes('/screenshot.png')) {
      if (isRunInProgress) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A run is already in progress' }));
        return;
      }
      
      const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const shift = urlParams.searchParams.get('shift') === 'evening' ? 'evening' : 'morning';
      
      isRunInProgress = true;
      currentShift = shift;
      runError = null;
      
      // Clear logs and latest screenshot
      try {
        const logPath = path.resolve(config.logDir, 'combined.log');
        const screenshotPath = path.resolve(config.screenshotDir, 'latest.png');
        if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
        if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
      } catch (e) {
        console.error('Failed to clear logs/screenshot:', e);
      }
      
      // Trigger execution in background
      (async () => {
        try {
          logger.info(`Manual trigger: Starting daily task automation for ${shift} shift...`);
          await executeTask(shift);
        } catch (e) {
          logger.error(`Manual run failed: ${e.message}`);
          runError = e.message;
        } finally {
          isRunInProgress = false;
        }
      })();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Automation started in the background' }));
      return;
    }
    if (req.url.startsWith('/run-bot/status')) {
      try {
        const logPath = path.resolve(config.logDir, 'combined.log');
        let logs = '';
        if (fs.existsSync(logPath)) {
          logs = fs.readFileSync(logPath, 'utf8');
        }
        const screenshotPath = path.resolve(config.screenshotDir, 'latest.png');
        const hasLatest = fs.existsSync(screenshotPath);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          running: isRunInProgress,
          shift: currentShift,
          error: runError,
          logs: logs,
          hasLatestScreenshot: hasLatest
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.url.startsWith('/run-bot/screenshot.png')) {
      try {
        const screenshotPath = path.resolve(config.screenshotDir, 'latest.png');
        if (fs.existsSync(screenshotPath)) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          fs.createReadStream(screenshotPath).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('No screenshot found');
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/run') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance Bot - Control Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0c10;
      --card-bg: rgba(25, 28, 36, 0.6);
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --accent: #00f2fe;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: rgba(255, 255, 255, 0.08);
      --success: #10b981;
      --error: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg);
      background-image: radial-gradient(circle at 50% 50%, #1c1d2e 0%, #0a0b10 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #fff 0%, var(--text-muted) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    header p {
      color: var(--text-muted);
      font-size: 1.1rem;
      font-weight: 300;
    }

    .container {
      width: 100%;
      max-width: 1200px;
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 2rem;
    }

    @media (max-width: 968px) {
      .container {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 1.5rem;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.8rem;
    }

    .panel-title {
      font-size: 1.25rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .badge {
      padding: 0.3rem 0.8rem;
      border-radius: 50px;
      font-size: 0.8rem;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .badge-idle {
      background: rgba(156, 163, 175, 0.15);
      color: var(--text-muted);
      border: 1px solid rgba(156, 163, 175, 0.3);
    }

    .badge-running {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { opacity: 0.8; }
      50% { opacity: 1; }
      100% { opacity: 0.8; }
    }

    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .btn {
      flex: 1;
      padding: 1rem;
      border-radius: 12px;
      font-family: inherit;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary) 0%, #312e81 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4);
      background: linear-gradient(135deg, var(--primary-hover) 0%, #1e1b4b 100%);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-2px);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .terminal {
      background: rgba(0, 0, 0, 0.5);
      border-radius: 12px;
      padding: 1rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #38bdf8;
      overflow-y: auto;
      height: 480px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
    }

    .viewport-container {
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 12px;
      border: 1px solid var(--border);
      height: 480px;
      overflow: hidden;
      position: relative;
    }

    .viewport-container img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .viewport-placeholder {
      text-align: center;
      color: var(--text-muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }

    .viewport-placeholder svg {
      width: 64px;
      height: 64px;
      stroke: var(--text-muted);
      opacity: 0.4;
    }

    .progress-bar {
      height: 4px;
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      position: relative;
      overflow: hidden;
      margin-bottom: 1rem;
      border-radius: 2px;
      display: none;
    }

    .progress-bar::after {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 50%;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      animation: loading 1.5s infinite;
    }

    @keyframes loading {
      0% { left: -50%; }
      100% { left: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Attendance Bot Control Center</h1>
    <p>Live execution manager & browser portal</p>
  </header>

  <div class="container">
    <div class="card">
      <div class="panel-header">
        <div class="panel-title">Console Output</div>
        <div id="status-badge" class="badge badge-idle">Idle</div>
      </div>

      <div class="controls">
        <button id="btn-morning" class="btn btn-primary" onclick="triggerRun('morning')">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m2.828-9.9a5 5 0 117.072 0l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          Run Morning Shift
        </button>
        <button id="btn-evening" class="btn btn-secondary" onclick="triggerRun('evening')">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
          Run Evening Shift
        </button>
      </div>

      <div id="loader" class="progress-bar"></div>
      <div id="terminal" class="terminal">Welcome to Attendance Bot Control Center.\\nSelect a shift above to trigger execution.</div>
    </div>

    <div class="card">
      <div class="panel-header">
        <div class="panel-title">Live Browser View</div>
      </div>
      
      <div id="viewport" class="viewport-container">
        <div class="viewport-placeholder">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          <p>No active browser session</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    let isPolling = false;
    let pollInterval = null;

    async function triggerRun(shift) {
      if (isPolling) return;
      
      document.getElementById('btn-morning').disabled = true;
      document.getElementById('btn-evening').disabled = true;
      document.getElementById('loader').style.display = 'block';
      document.getElementById('terminal').textContent = 'Initializing automation run...\\n';
      
      try {
        const res = await fetch(\`/run-bot?shift=\${shift}\`);
        const data = await res.json();
        if (data.success) {
          startPolling();
        } else {
          showError(data.error || 'Failed to start run');
        }
      } catch (e) {
        showError(e.message);
      }
    }

    function showError(msg) {
      document.getElementById('terminal').textContent += \`\\n[ERROR] \${msg}\\n\`;
      document.getElementById('btn-morning').disabled = false;
      document.getElementById('btn-evening').disabled = false;
      document.getElementById('loader').style.display = 'none';
    }

    function startPolling() {
      isPolling = true;
      document.getElementById('status-badge').className = 'badge badge-running';
      document.getElementById('status-badge').textContent = 'Running';
      document.getElementById('loader').style.display = 'block';
      
      pollInterval = setInterval(pollStatus, 1500);
      pollStatus(); // Initial poll
    }

    function stopPolling() {
      isPolling = false;
      clearInterval(pollInterval);
      document.getElementById('status-badge').className = 'badge badge-idle';
      document.getElementById('status-badge').textContent = 'Idle';
      document.getElementById('btn-morning').disabled = false;
      document.getElementById('btn-evening').disabled = false;
      document.getElementById('loader').style.display = 'none';
    }

    async function pollStatus() {
      try {
        const res = await fetch('/run-bot/status');
        const data = await res.json();
        
        // Update logs terminal
        const term = document.getElementById('terminal');
        const atBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 50;
        term.textContent = data.logs || 'Initializing logs...';
        if (atBottom) {
          term.scrollTop = term.scrollHeight;
        }

        // Update screenshot
        const viewport = document.getElementById('viewport');
        if (data.hasLatestScreenshot) {
          viewport.innerHTML = \`<img src="/run-bot/screenshot.png?t=\${Date.now()}" id="browser-view" />\`;
        } else if (data.running) {
          viewport.innerHTML = \`
            <div class="viewport-placeholder">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              <p>Launching browser and navigating...</p>
            </div>
          \`;
        } else {
          viewport.innerHTML = \`
            <div class="viewport-placeholder">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              <p>No active browser session</p>
            </div>
          \`;
        }

        if (!data.running) {
          stopPolling();
          if (data.error) {
            term.textContent += \`\\n\\n[RUN FAILED] \${data.error}\\n\`;
          } else {
            term.textContent += '\\n\\n[RUN COMPLETED]\\n';
          }
          term.scrollTop = term.scrollHeight;
        }
      } catch (e) {
        console.error('Poll failed:', e);
      }
    }

    // Auto-check on load if already running
    window.addEventListener('load', async () => {
      try {
        const res = await fetch('/run-bot/status');
        const data = await res.json();
        if (data.running) {
          document.getElementById('btn-morning').disabled = true;
          document.getElementById('btn-evening').disabled = true;
          startPolling();
        }
      } catch (e) {}
    });
  </script>
</body>
</html>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('healthy');
  }).listen(process.env.PORT || 3000, () => {
    logger.info(`Health check server listening on port ${process.env.PORT || 3000}`);
  });
}

// Parse CLI arguments
const args = process.argv.slice(2);
const runNow = args.includes('--run-now');
const dryRun = args.includes('--dry-run');
const runMorning = args.includes('--morning');
const runEvening = args.includes('--evening');

// Override dry run from CLI
if (dryRun) {
  config.dryRun = true;
  logger.info('🔧 DRY RUN mode enabled via CLI flag');
}

/**
 * Main application entry point
 */
async function main() {
  const fs = require('fs');
  const cp = require('child_process');
  
  let diag = [];
  function diagLog(msg) {
    logger.info(msg);
    diag.push(msg);
  }
  function diagWarn(msg) {
    logger.warn(msg);
    diag.push(`[WARN] ${msg}`);
  }

  diagLog('=== RUNNING DIAGNOSTICS ===');
  try {
    diagLog(`Platform: ${process.platform}`);
    diagLog(`User: ${process.env.USER || 'unknown'} (UID: ${process.getuid ? process.getuid() : 'N/A'})`);
    diagLog(`Env DISPLAY: ${process.env.DISPLAY}`);
    
    // Check files in /tmp
    try {
      const tmpFiles = cp.execSync('ls -la /tmp /tmp/.X11-unix 2>&1').toString();
      diagLog(`Files in /tmp & /tmp/.X11-unix:\n${tmpFiles}`);
    } catch (e) {
      diagWarn(`Failed to list /tmp: ${e.message}`);
    }

    // Check running processes
    try {
      const processes = cp.execSync('ps aux 2>&1 || ps -ef 2>&1').toString();
      diagLog(`Running processes:\n${processes}`);
    } catch (e) {
      diagWarn(`Failed to list processes: ${e.message}`);
    }

    // Check chromium path
    try {
      const chromVersion = cp.execSync('chromium --version 2>&1 || google-chrome --version 2>&1').toString();
      diagLog(`Chromium version: ${chromVersion.trim()}`);
    } catch (e) {
      diagWarn(`Failed to get chromium version: ${e.message}`);
    }

    // Try starting a test Chromium on DISPLAY to see why it fails
    try {
      diagLog('Testing manual chromium launch on active display...');
      const displays = fs.readdirSync('/tmp/.X11-unix').map(f => f.replace('X', ':'));
      const activeDisplay = displays.length > 0 ? displays[0] : ':99';
      diagLog(`Found active X11 displays: ${displays.join(', ')}. Using ${activeDisplay}`);

      const proc = cp.spawn('chromium', [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        'about:blank'
      ], {
        env: { ...process.env, DISPLAY: activeDisplay },
        detached: true
      });
      
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      // Wait 5 seconds
      await new Promise(r => setTimeout(r, 5000));
      
      // Try connecting to debug port
      try {
        const res = cp.execSync('curl -s http://127.0.0.1:9222/json/version 2>&1').toString();
        diagLog(`Successfully connected to manual chromium debug port! Response:\n${res}`);
      } catch (e) {
        diagWarn(`Failed to connect to manual chromium debug port: ${e.message}`);
      }

      // Kill the process
      proc.kill('SIGKILL');
      
      diagLog(`Manual chromium stdout:\n${stdout}`);
      diagLog(`Manual chromium stderr:\n${stderr}`);
    } catch (e) {
      diagWarn(`Manual chromium launch test failed: ${e.message}`);
    }
  } catch (err) {
    diagLog(`Diagnostics error: ${err.message}`);
  }
  diagLog('=== END DIAGNOSTICS ===');

  try {
    fs.writeFileSync('/app/diagnostics.log', diag.join('\n'));
  } catch (err) {
    logger.error('Failed to write diagnostics log file:', err);
  }

  logger.info('');
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║     HPU Backoffice - Attendance Autoloader       ║');
  logger.info('║     Daily Task Form Automation                   ║');
  logger.info('╠══════════════════════════════════════════════════╣');
  logger.info(`║  User ID:     ${config.userId.padEnd(35)}║`);
  logger.info(`║  Timezone:    ${config.timezone.padEnd(35)}║`);
  logger.info(`║  Dry Run:     ${String(config.dryRun).padEnd(35)}║`);
  logger.info(`║  Headless:    ${String(config.headless).padEnd(35)}║`);
  logger.info(`║  AI:          ${(config.geminiApiKey && config.geminiApiKey !== 'your_gemini_api_key_here' ? 'Gemini ✅' : 'Fallback (no API key)').padEnd(35)}║`);
  logger.info('╚══════════════════════════════════════════════════╝');
  logger.info('');

  if (runNow || runMorning || runEvening) {
    // Immediate execution mode
    const shift = runEvening ? 'evening' : 'morning';
    logger.info(`🏃 Running ${shift} shift task immediately...`);

    try {
      await executeTask(shift);

      // If --run-now, run both shifts
      if (runNow && !runMorning && !runEvening) {
        logger.info('Running evening shift as well (--run-now mode)...');
        await executeTask('evening');
      }
    } catch (error) {
      logger.error('Immediate execution failed:', error);
    }
  }

  // Scheduler mode (always keep running)
  startScheduler();

  // Keep the process alive
  logger.info('Process running. Press Ctrl+C to stop.');
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`\n${signal} received. Shutting down gracefully...`);
  await closeBrowser();
  logger.info('Goodbye! 👋');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start the application
main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
