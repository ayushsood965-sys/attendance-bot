require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
const { startScheduler, executeTask } = require('./scheduler');
const { closeBrowser } = require('./browser');

// Start a simple HTTP health check server on Linux to satisfy Coolify/Traefik routing checks
if (process.platform === 'linux') {
  const http = require('http');
  const fs = require('fs');
  http.createServer((req, res) => {
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

    // Try starting a test Xvfb and chromium to see why it crashes
    try {
      diagLog('Testing manual chromium launch...');
      const output = cp.execSync('chromium --headless --no-sandbox --disable-gpu --dump-dom https://www.google.com 2>&1').toString();
      diagLog(`Test chromium headless fetch succeeded! Length: ${output.length}`);
    } catch (e) {
      diagWarn(`Test chromium headless fetch failed: ${e.message}\nOutput: ${e.stdout?.toString() || e.stderr?.toString()}`);
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
