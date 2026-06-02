const { app, BrowserWindow, Tray, Menu, shell, ipcMain, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = 7000;
const APP_URL = `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === 'win32';

// Resolve the odysseus app directory.
// In production (packaged), it's bundled under resources/odysseus.
// In dev, this file lives at odysseus/electron/src/main.js, so root is two levels up.
const ODYSSEUS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'odysseus')
  : path.join(__dirname, '..');

const VENV_DIR = path.join(ODYSSEUS_DIR, 'venv');
const VENV_PYTHON = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
const VENV_PIP = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'pip.exe')
  : path.join(VENV_DIR, 'bin', 'pip');
const SETUP_DONE_FLAG = path.join(ODYSSEUS_DIR, 'data', '.setup_complete');

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindow = null;
let loadingWindow = null;
let tray = null;
let backendProcess = null;
let isQuitting = false;

// ─── Paths ────────────────────────────────────────────────────────────────────

function getIconPath(name = 'icon') {
  const ext = IS_WIN ? 'ico' : 'png';
  const p = path.join(__dirname, 'assets', `${name}.${ext}`);
  return fs.existsSync(p) ? p : null;
}

function getTrayIconPath() {
  // Prefer dedicated tray icon, fall back to main icon, then null
  return getIconPath('tray') || getIconPath('icon');
}

// ─── Loading Window ───────────────────────────────────────────────────────────

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
  loadingWindow.setVisibleOnAllWorkspaces(true);
}

function setLoadingStatus(message, progress = -1) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send('status', { message, progress });
  }
}

function closeLoadingWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close();
    loadingWindow = null;
  }
}

// ─── Main Window ──────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Odysseus',
    icon: getIconPath('icon') || undefined,
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  // Open external links in the system browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith('about:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (IS_WIN && tray) {
        // Show a one-time balloon notification so users know it's in the tray
        const shownKey = path.join(app.getPath('userData'), '.tray_notified');
        if (!fs.existsSync(shownKey)) {
          tray.displayBalloon({
            title: 'Odysseus is still running',
            content: 'Find it in the system tray. Right-click the icon to quit.',
            iconType: 'info',
          });
          fs.writeFileSync(shownKey, '1');
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = getTrayIconPath();
  const { nativeImage } = require('electron');
  tray = new Tray(iconPath || nativeImage.createEmpty());
  tray.setToolTip('Odysseus');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Odysseus',
      click: () => showMainWindow(),
    },
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(APP_URL),
    },
    { type: 'separator' },
    {
      label: 'Restart Backend',
      click: () => restartBackend(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => quitApp(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── Python / venv helpers ───────────────────────────────────────────────────

function findSystemPython() {
  const candidates = IS_WIN
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version 2>&1`, { timeout: 5000 }).toString();
      const match = out.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1]);
        const minor = parseInt(match[2]);
        if (major === 3 && minor >= 11) return cmd;
      }
    } catch {
      // not found or wrong version
    }
  }
  return null;
}

async function runSetup(pythonCmd) {
  return new Promise((resolve, reject) => {
    // If venv already exists (e.g. from a previous interrupted setup), skip
    // straight to pip install to continue where we left off.
    const venvExists = fs.existsSync(VENV_PYTHON);

    const runPipInstall = () => {
      setLoadingStatus('Installing dependencies (this may take a few minutes)…', 25);

      // Step 2: pip install
      const pipProc = spawn(VENV_PIP, [
        'install', '-r', 'requirements.txt',
        '--no-warn-script-location',
      ], {
        cwd: ODYSSEUS_DIR,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      let installProgress = 25;
      let pipErr = '';
      pipProc.stderr.on('data', (d) => { pipErr += d.toString(); });
      pipProc.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('Collecting') || line.includes('Installing')) {
          installProgress = Math.min(installProgress + 1, 75);
          setLoadingStatus(`Installing: ${line.slice(0, 60)}…`, installProgress);
        }
      });

      pipProc.on('close', (code2) => {
        if (code2 !== 0) {
          return reject(new Error(
            `pip install failed (exit ${code2}).

${pipErr.trim() || 'No details available.'}

Check your internet connection and that requirements.txt exists at:
${ODYSSEUS_DIR}`
          ));
        }

        setLoadingStatus('Running first-time setup…', 80);

        // Step 3: python setup.py (optional — skip gracefully if not present)
        const setupPy = path.join(ODYSSEUS_DIR, 'setup.py');
        if (!fs.existsSync(setupPy)) {
          fs.mkdirSync(path.dirname(SETUP_DONE_FLAG), { recursive: true });
          fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString());
          return resolve();
        }

        const setupProc = spawn(VENV_PYTHON, ['setup.py'], {
          cwd: ODYSSEUS_DIR,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });

        let setupErr = '';
        setupProc.stderr.on('data', (d) => { setupErr += d.toString(); });

        setupProc.on('close', (code3) => {
          if (code3 !== 0) {
            return reject(new Error(
              `setup.py failed (exit ${code3}).

${setupErr.trim() || 'No details available.'}`
            ));
          }

          // Mark setup as done
          fs.mkdirSync(path.dirname(SETUP_DONE_FLAG), { recursive: true });
          fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString());
          resolve();
        });
      });
    }; // end runPipInstall

    if (venvExists) {
      // Venv already exists — resume from pip install
      setLoadingStatus('Resuming setup from previous attempt…', 20);
      runPipInstall();
    } else {
      // Step 1: create venv from scratch
      setLoadingStatus('Creating Python virtual environment…', 10);
      const venvProc = spawn(pythonCmd, ['-m', 'venv', VENV_DIR], {
        cwd: ODYSSEUS_DIR,
      });

      let venvErr = '';
      venvProc.stderr.on('data', (d) => { venvErr += d.toString(); });

      venvProc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(
            `Failed to create virtual environment (exit ${code}).

${venvErr.trim() || 'No details available.'}

Python: ${pythonCmd}
Venv path: ${VENV_DIR}`
          ));
        }
        runPipInstall();
      });
    }
  });
}

// ─── Backend ──────────────────────────────────────────────────────────────────

function startBackend() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(VENV_PYTHON)) {
      return reject(new Error(`Python venv not found at:\n${VENV_PYTHON}`));
    }

    backendProcess = spawn(VENV_PYTHON, [
      '-m', 'uvicorn', 'app:app',
      '--host', '127.0.0.1',
      '--port', String(PORT),
    ], {
      cwd: ODYSSEUS_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const logPath = path.join(app.getPath('userData'), 'backend.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    backendProcess.stdout.pipe(logStream);
    backendProcess.stderr.pipe(logStream);

    backendProcess.on('error', (err) => {
      reject(new Error(`Failed to start backend: ${err.message}`));
    });

    backendProcess.on('exit', (code, signal) => {
      if (!isQuitting) {
        dialog.showErrorBox(
          'Odysseus Backend Crashed',
          `The backend process exited unexpectedly (code ${code}).\n\nCheck the log at:\n${logPath}`
        );
      }
    });

    // Poll until the server responds
    waitForServer(APP_URL, 60, 1000)
      .then(resolve)
      .catch(() => reject(new Error(`Server didn't start within 60 seconds.\nCheck:\n${logPath}`)));
  });
}

function waitForServer(url, retries, interval) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode < 500) resolve();
        else retry();
      }).on('error', retry);
    };

    const retry = () => {
      attempts++;
      const pct = Math.min(85 + Math.floor((attempts / retries) * 12), 97);
      setLoadingStatus(`Starting server… (${attempts}/${retries})`, pct);
      if (attempts >= retries) return reject();
      setTimeout(check, interval);
    };

    check();
  });
}

function stopBackend() {
  if (backendProcess) {
    try {
      if (IS_WIN) {
        spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t']);
      } else {
        backendProcess.kill('SIGTERM');
      }
    } catch { /* already dead */ }
    backendProcess = null;
  }
}

async function restartBackend() {
  if (mainWindow) mainWindow.hide();
  createLoadingWindow();
  setLoadingStatus('Restarting backend…', 0);
  stopBackend();

  try {
    await startBackend();
    closeLoadingWindow();
    showMainWindow();
    mainWindow.loadURL(APP_URL);
  } catch (err) {
    closeLoadingWindow();
    dialog.showErrorBox('Restart Failed', err.message);
    showMainWindow();
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

function quitApp() {
  isQuitting = true;
  stopBackend();
  app.quit();
}

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

app.on('window-all-closed', () => {
  // Keep app running on all platforms (tray app)
  // Do nothing — quitting is only via tray menu
});

app.on('activate', () => {
  showMainWindow();
});

// IPC from loading window
ipcMain.on('quit', () => quitApp());

// ─── Boot Sequence ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Show loading screen immediately
  createLoadingWindow();
  setLoadingStatus('Initializing…', 0);

  // Create tray and main window in background
  createTray();
  createMainWindow();

  // Check if first-run setup is needed
  const needsSetup = !fs.existsSync(SETUP_DONE_FLAG) || !fs.existsSync(VENV_PYTHON);

  if (needsSetup) {
    setLoadingStatus('Checking Python installation…', 5);
    const pythonCmd = findSystemPython();

    if (!pythonCmd) {
      closeLoadingWindow();
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Python Not Found',
        message: 'Odysseus requires Python 3.11 or newer.',
        detail: 'Please install Python from python.org, then restart Odysseus.\n\nMake sure to check "Add Python to PATH" during installation.',
        buttons: ['Open python.org', 'Quit'],
        defaultId: 0,
      });
      if (response === 0) shell.openExternal('https://www.python.org/downloads/');
      quitApp();
      return;
    }

    try {
      await runSetup(pythonCmd);
    } catch (err) {
      closeLoadingWindow();
      dialog.showErrorBox('Setup Failed', err.message);
      quitApp();
      return;
    }
  }

  // Start the backend
  try {
    setLoadingStatus('Starting Odysseus backend…', 85);
    await startBackend();
  } catch (err) {
    closeLoadingWindow();
    dialog.showErrorBox('Failed to Start', err.message);
    quitApp();
    return;
  }

  // Load the app
  setLoadingStatus('Almost ready…', 99);
  await mainWindow.loadURL(APP_URL);

  closeLoadingWindow();
  mainWindow.show();
  mainWindow.focus();
});