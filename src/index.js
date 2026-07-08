require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
const { startScheduler, executeTask } = require('./scheduler');
const { closeBrowser } = require('./browser');

// Start a simple HTTP health check server on Linux to satisfy Coolify/Traefik routing checks
if (process.platform === 'linux') {
  const http = require('http');
  http.createServer((req, res) => {
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
  logger.info('=== RUNNING DIAGNOSTICS ===');
  try {
    const cp = require('child_process');
    logger.info(`Platform: ${process.platform}`);
    logger.info(`User: ${process.env.USER || 'unknown'} (UID: ${process.getuid ? process.getuid() : 'N/A'})`);
    logger.info(`Env DISPLAY: ${process.env.DISPLAY}`);
    
    // Check files in /tmp
    try {
      const tmpFiles = cp.execSync('ls -la /tmp /tmp/.X11-unix 2>&1').toString();
      logger.info(`Files in /tmp & /tmp/.X11-unix:\n${tmpFiles}`);
    } catch (e) {
      logger.warn(`Failed to list /tmp: ${e.message}`);
    }

    // Check running processes
    try {
      const processes = cp.execSync('ps aux 2>&1 || ps -ef 2>&1').toString();
      logger.info(`Running processes:\n${processes}`);
    } catch (e) {
      logger.warn(`Failed to list processes: ${e.message}`);
    }

    // Check chromium path
    try {
      const chromVersion = cp.execSync('chromium --version 2>&1 || google-chrome --version 2>&1').toString();
      logger.info(`Chromium version: ${chromVersion.trim()}`);
    } catch (e) {
      logger.warn(`Failed to get chromium version: ${e.message}`);
    }

    // Try starting a test Xvfb and chromium to see why it crashes
    try {
      logger.info('Testing manual chromium launch...');
      const output = cp.execSync('chromium --headless --no-sandbox --disable-gpu --dump-dom https://www.google.com 2>&1').toString();
      logger.info(`Test chromium headless fetch succeeded! Length: ${output.length}`);
    } catch (e) {
      logger.warn(`Test chromium headless fetch failed: ${e.message}\nOutput: ${e.stdout?.toString() || e.stderr?.toString()}`);
    }
  } catch (err) {
    logger.error('Diagnostics error:', err);
  }
  logger.info('=== END DIAGNOSTICS ===');

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
