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
      const replacement = match[0] + `\n  if (chrome.process) {\n    const fs = require('fs');\n    const outLog = fs.createWriteStream('/app/chrome-stdout.log', { flags: 'a' });\n    const errLog = fs.createWriteStream('/app/chrome-stderr.log', { flags: 'a' });\n    chrome.process.stdout.pipe(outLog);\n    chrome.process.stderr.pipe(errLog);\n  }`;
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
        
        // Find active display
        const displays = fs.readdirSync('/tmp/.X11-unix').map(f => f.replace('X', ':'));
        const activeDisplay = displays.length > 0 ? displays[0] : ':99';
        
        let testOutput = '';
        try {
          const out = cp.execSync(`DISPLAY=${activeDisplay} chromium --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer --dump-dom https://www.google.com 2>&1`).toString();
          testOutput = `Headless test fetch succeeded! Length: ${out.length}`;
        } catch (err) {
          testOutput = `Headless test fetch failed:\n${err.message}\nOutput:\n${err.stdout?.toString() || err.stderr?.toString()}`;
        }

        let headedOutput = '';
        try {
          const proc = cp.spawn('chromium', [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--remote-debugging-port=9333',
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

          await new Promise(r => setTimeout(r, 4000));
          
          let connectRes = '';
          try {
            const fetchRes = await fetch('http://127.0.0.1:9333/json/version');
            connectRes = await fetchRes.text();
          } catch (e) {
            connectRes = `Connection failed: ${e.message}`;
          }
          
          proc.kill('SIGKILL');
          headedOutput = `Connection: ${connectRes.trim()}\nStdout: ${stdout.trim()}\nStderr: ${stderr.trim()}`;
        } catch (err) {
          headedOutput = `Headed test failed: ${err.message}`;
        }

        let testUserDirTmp = '';
        try {
          const proc = cp.spawn('chromium', [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--remote-debugging-port=9444',
            '--remote-debugging-address=0.0.0.0',
            '--user-data-dir=/tmp/test-user-dir',
            'about:blank'
          ], {
            env: { ...process.env, DISPLAY: activeDisplay },
            detached: true
          });
          await new Promise(r => setTimeout(r, 2000));
          let res = '';
          try {
            const fetchRes = await fetch('http://127.0.0.1:9444/json/version');
            res = await fetchRes.text();
          } catch (e) {
            res = `failed: ${e.message}`;
          }
          proc.kill('SIGKILL');
          testUserDirTmp = res.includes('Browser') ? 'Success' : `Failed: ${res.trim()}`;
        } catch (e) {
          testUserDirTmp = `Error: ${e.message}`;
        }

        let testUserDirApp = '';
        try {
          const proc = cp.spawn('chromium', [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--remote-debugging-port=9555',
            '--remote-debugging-address=0.0.0.0',
            '--user-data-dir=/app/test-user-dir',
            'about:blank'
          ], {
            env: { ...process.env, DISPLAY: activeDisplay },
            detached: true
          });
          await new Promise(r => setTimeout(r, 2000));
          let res = '';
          try {
            const fetchRes = await fetch('http://127.0.0.1:9555/json/version');
            res = await fetchRes.text();
          } catch (e) {
            res = `failed: ${e.message}`;
          }
          proc.kill('SIGKILL');
          testUserDirApp = res.includes('Browser') ? 'Success' : `Failed: ${res.trim()}`;
        } catch (e) {
          testUserDirApp = `Error: ${e.message}`;
        }

        let testRealFlags = '';
        try {
          const proc = cp.spawn('chromium', [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--remote-debugging-address=0.0.0.0',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,RenderDocument,AutomationControlled',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-background-networking',
            '--disable-client-side-phishing-detection',
            '--disable-sync',
            '--metrics-recording-only',
            '--disable-default-apps',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-ipc-flooding-protection',
            '--password-store=basic',
            '--use-mock-keychain',
            '--force-fieldtrials=*BackgroundTracing/default/',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-domain-reliability',
            '--propagate-iph-for-testing',
            '--window-size=1366,768',
            '--lang=en-IN',
            '--user-data-dir=/tmp/test-real-flags',
            '--remote-debugging-port=9666',
            'about:blank'
          ], {
            env: { ...process.env, DISPLAY: activeDisplay },
            detached: true
          });
          
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', d => { stdout += d.toString(); });
          proc.stderr.on('data', d => { stderr += d.toString(); });

          await new Promise(r => setTimeout(r, 2000));
          let res = '';
          try {
            const fetchRes = await fetch('http://127.0.0.1:9666/json/version');
            res = await fetchRes.text();
          } catch (e) {
            res = `failed: ${e.message}`;
          }
          proc.kill('SIGKILL');
          testRealFlags = `Connection: ${res.trim()}\nStdout: ${stdout.trim()}\nStderr: ${stderr.trim()}`;
        } catch (e) {
          testRealFlags = `Error: ${e.message}`;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Processes:\n${processes}\n\nFiles:\n${tmpFiles}\n\nActive Display: ${activeDisplay}\n\nHeadless Test Output:\n${testOutput}\n\nHeaded Test Output:\n${headedOutput}\n\nUser Data Dir Tmp Test: ${testUserDirTmp}\nUser Data Dir App Test: ${testUserDirApp}\nReal Flags Test: ${testRealFlags}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${e.message}`);
      }
      return;
    }
    if (req.url === '/chrome-log') {
      try {
        const fs = require('fs');
        const path = require('path');
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
