import { fileURLToPath } from 'node:url';
import path, { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
global.__dirname = __dirname;
global.__filename = __filename;

import { activate, checkStored } from '../licenseSystem/client-activation.js';
import { getMachineId } from '../licenseSystem/machine-id.js';

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { promises as fs } from 'fs-extra';
import logger from '../scripts/logger.js';
import BackendManager from '../scripts/backendManager.js';
import { setupAutoUpdater, checkForUpdates, startDownload } from '../scripts/autoUpdater.js';
import { autoUpdater } from 'electron-updater';
import { createLockFile } from '../scripts/firstRun.js';
import { generateReceiptHtml } from '../scripts/receiptBuilder.js';

// --- المتغيرات العامة ---
const isDev = !app.isPackaged;

let mainWindow = null;
let splashWindow = null;
let activationWindow = null;
let isQuitting = false;
let backendReady = false;
let splashTimeout = null;

const backendManager = new BackendManager();

// --- منع تشغيل أكثر من نسخة ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const target = mainWindow || activationWindow;
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });
}

// --- نافذة البرنامج الرئيسية ---
function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 700,
    show: false,
    icon: isDev ? join(__dirname, '../../build/icon.png') : join(__dirname, '../build/icon.png'),
    webPreferences: {
      devTools: isDev,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.mjs'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    setupAutoUpdater(mainWindow);
    mainWindow.__readyToShow = true;
    tryToShowMainWindowAfterSplash();
  });

  mainWindow.removeMenu();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error(
      `Main window failed to load: ${errorCode} - ${errorDescription} - ${validatedURL}`
    );
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('Main window finished loading');
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const tryLoadIndex = async () => {
      try {
        const resourcesPath = process.resourcesPath;
        const indexPath = path.join(resourcesPath, 'dist-electron', 'dist', 'index.html');
        logger.info(`Trying to load from resources path: ${indexPath}`);
        await mainWindow.loadFile(indexPath);
        logger.info('Successfully loaded from resources path');
        return;
      } catch (err) {
        logger.warn(`Failed to load from resources path: ${err.message}`);
      }

      try {
        const relativePath = path.join(__dirname, '../../dist/index.html');
        logger.info(`Trying to load from relative path: ${relativePath}`);
        await mainWindow.loadFile(relativePath);
        logger.info('Successfully loaded from relative path');
        return;
      } catch (err) {
        logger.warn(`Failed to load from relative path: ${err.message}`);
      }

      let lastError;
      try {
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'dist-electron', 'dist', 'index.html');
        logger.info(`Trying to load from app path: ${indexPath}`);
        await mainWindow.loadFile(indexPath);
        logger.info('Successfully loaded from app path');
        return;
      } catch (err) {
        lastError = err;
        logger.warn(`Failed to load from app path: ${err.message}`);
      }

      logger.error(
        `All path resolution strategies failed. Last error: ${lastError?.message || 'unknown'}`
      );
      throw new Error('Failed to locate index.html file');
    };

    tryLoadIndex().catch((err) => {
      logger.error(`Failed to load index.html after all attempts: ${err.message}`);
    });
  }

  mainWindow.on('close', async (event) => {
    if (isQuitting) return;
    event.preventDefault();

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['إلغاء', 'إغلاق'],
      defaultId: 0,
      cancelId: 0,
      title: 'تأكيد الإغلاق',
      message: 'هل أنت متأكد من إغلاق التطبيق؟',
      detail: 'قد يكون الإغلاق عن طريق الخطأ. هل تريد المتابعة؟',
      noLink: true,
    });

    if (response === 1) {
      isQuitting = true;
      await backendManager.CleanupBackendProcess();
      mainWindow.close();
    }
  });

  mainWindow.on('closed', async () => {
    logger.info('Main window closed');
    mainWindow = null;
    await backendManager.CleanupBackendProcess();
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('getPrinters', async () => {
    try {
      let targetWindow = mainWindow;

      if (!targetWindow || targetWindow.isDestroyed()) {
        const allWindows = BrowserWindow.getAllWindows();
        if (allWindows.length > 0) {
          targetWindow = allWindows[0];
        } else {
          logger.warn('No windows available for getting printers');
          return [];
        }
      }

      if (!targetWindow.webContents) {
        logger.warn('WebContents not available');
        return [];
      }

      let printers;
      try {
        printers = await targetWindow.webContents.getPrintersAsync();
      } catch (getPrintersError) {
        logger.error('Error calling getPrinters():', getPrintersError);
        if (!targetWindow.isVisible()) {
          logger.info('Window not visible, attempting to show temporarily');
          targetWindow.show();
          await new Promise((resolve) => setTimeout(resolve, 100));
          printers = await targetWindow.webContents.getPrintersAsync();
          if (targetWindow !== mainWindow) {
            targetWindow.hide();
          }
        } else {
          throw getPrintersError;
        }
      }

      logger.info(`Found ${printers.length} printers`);
      logger.debug('Printers from Electron', { printers });

      if (!printers || printers.length === 0) {
        logger.warn('No printers found on system');
        return [];
      }

      const formattedPrinters = printers.map((printer) => ({
        name: printer.name,
        displayName: printer.displayName || printer.name,
        description: printer.description || '',
        status: printer.status || 0,
        isDefault: printer.isDefault || false,
      }));

      return formattedPrinters;
    } catch (error) {
      logger.error('Error getting printers:', error);
      return [];
    }
  });

  ipcMain.handle('print-receipt', async (_event, { printerName, receiptData, companyInfo }) => {
    try {
      if (!receiptData) throw new Error('Receipt data is required');
      if (!companyInfo) throw new Error('Company info is required');

      const PIXELS_PER_MM = 3.78;
      const PAPER_SIZE_CONFIGS = {
        'roll-58': { widthMM: 58, heightMM: 297, margins: { marginType: 'none' } },
        'roll-80': { widthMM: 80, heightMM: 297, margins: { marginType: 'none' } },
        'roll-88': { widthMM: 88, heightMM: 297, margins: { marginType: 'none' } },
        a4: { widthMM: 210, heightMM: 297, margins: { marginType: 'default' } },
        a5: { widthMM: 148, heightMM: 210, margins: { marginType: 'default' } },
      };

      const invoiceType = companyInfo.invoiceType || 'roll-80';
      const invoiceTheme = companyInfo.invoiceTheme || 'classic';
      const paperConfig = PAPER_SIZE_CONFIGS[invoiceType] || PAPER_SIZE_CONFIGS['roll-80'];

      logger.debug('Printing receipt', {
        printerName,
        invoiceType,
        invoiceTheme,
        paperConfig,
        receiptDataLength: receiptData?.length,
      });

      const htmlContent = generateReceiptHtml(receiptData, invoiceType, invoiceTheme);

      const printWindow = new BrowserWindow({
        show: false,
        width: Math.round(paperConfig.widthMM * PIXELS_PER_MM),
        height: Math.round(paperConfig.heightMM * PIXELS_PER_MM),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

      try {
        await printWindow.webContents.executeJavaScript('document.fonts.ready');
      } catch (err) {
        logger.warn('Error waiting for fonts:', err);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const printOptions = {
        silent: true,
        printBackground: true,
        deviceName: printerName || undefined,
        pageSize: {
          width: paperConfig.widthMM * 1000,
          height: paperConfig.heightMM * 1000,
        },
        margins: paperConfig.margins,
      };

      return new Promise((resolve) => {
        printWindow.webContents.print(printOptions, (success, errorType) => {
          setTimeout(() => {
            if (!printWindow.isDestroyed()) {
              printWindow.close();
            }
          }, 100);

          if (success) {
            logger.info('Receipt printed successfully');
            resolve({ success: true, message: 'تمت الطباعة بنجاح' });
          } else {
            logger.error('Print failed:', errorType);
            resolve({
              success: false,
              error: `فشل في الطباعة: ${errorType || 'خطأ غير معروف'}`,
            });
          }
        });
      });
    } catch (error) {
      logger.error('Error printing receipt:', error);
      return {
        success: false,
        error: error.message || 'فشل في الطباعة',
      };
    }
  });

  ipcMain.handle('preview-receipt', async (_event, { receiptData, companyInfo }) => {
    try {
      if (!receiptData) throw new Error('Receipt data is required');
      if (!companyInfo) throw new Error('Company info is required');

      const PIXELS_PER_MM = 3.78;
      const PAPER_SIZE_CONFIGS = {
        'roll-58': { widthMM: 58, heightMM: 297, margins: { marginType: 'none' } },
        'roll-80': { widthMM: 80, heightMM: 297, margins: { marginType: 'none' } },
        'roll-88': { widthMM: 88, heightMM: 297, margins: { marginType: 'none' } },
        a4: { widthMM: 210, heightMM: 297, margins: { marginType: 'default' } },
        a5: { widthMM: 148, heightMM: 210, margins: { marginType: 'default' } },
      };

      const invoiceType = companyInfo.invoiceType || 'roll-80';
      const invoiceTheme = companyInfo.invoiceTheme || 'classic';
      const paperConfig = PAPER_SIZE_CONFIGS[invoiceType] || PAPER_SIZE_CONFIGS['roll-80'];

      logger.debug('Previewing receipt', {
        invoiceType,
        invoiceTheme,
        paperConfig,
        receiptDataLength: receiptData?.length,
      });

      const htmlContent = generateReceiptHtml(receiptData, invoiceType, invoiceTheme);

      const printWindow = new BrowserWindow({
        show: true,
        width: Math.round(paperConfig.widthMM * PIXELS_PER_MM),
        height: Math.round(paperConfig.heightMM * PIXELS_PER_MM),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

      try {
        await printWindow.webContents.executeJavaScript('document.fonts.ready');
      } catch (err) {
        logger.warn('Error waiting for fonts:', err);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        success: true,
        message: 'تمت الطباعة بنجاح',
      };
    } catch (error) {
      logger.error('Error printing receipt:', error);
      return {
        success: false,
        error: error.message || 'فشل في الطباعة',
      };
    }
  });

  ipcMain.handle('cut-paper', async () => {
    try {
      logger.debug('Cutting paper command received');
      return { success: true };
    } catch (error) {
      logger.error('Error cutting paper:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('kick-drawer', async () => {
    try {
      logger.debug('Kicking cash drawer command received');
      return { success: true };
    } catch (error) {
      logger.error('Error kicking cash drawer:', error);
      return { success: false, error: error.message };
    }
  });
}

// --- نافذة التفعيل ---
function createActivationWindow() {
  if (activationWindow) return;

  activationWindow = new BrowserWindow({
    width: 540,
    height: 500,
    resizable: false,
    center: true,
    frame: true,
    show: false,
    title: 'تفعيل نقطة بلس',
    icon: isDev ? join(__dirname, '../../build/icon.png') : join(__dirname, '../build/icon.png'),
    webPreferences: {
      devTools: isDev,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.mjs'),
    },
  });

  activationWindow.removeMenu();

  const loadActivationWindow = async () => {
    if (isDev) {
      // Dev: Vite dev server + createWebHistory → plain path URL
      await activationWindow.loadURL('http://localhost:5173/activation');
      return;
    }

    // Production: createWebHashHistory → loadFile with { hash: '/activation' }
    try {
      const p = path.join(process.resourcesPath, 'dist-electron', 'dist', 'index.html');
      logger.info(`Trying activation from resources path: ${p}`);
      await activationWindow.loadFile(p, { hash: '/activation' });
      logger.info('Loaded activation window from resources path');
      return;
    } catch (err) {
      logger.warn(`Failed activation resources path: ${err.message}`);
    }

    try {
      const p = path.join(__dirname, '../../dist/index.html');
      logger.info(`Trying activation from relative path: ${p}`);
      await activationWindow.loadFile(p, { hash: '/activation' });
      logger.info('Loaded activation window from relative path');
      return;
    } catch (err) {
      logger.warn(`Failed activation relative path: ${err.message}`);
    }

    try {
      const appPath = app.getAppPath();
      const p = path.join(appPath, 'dist-electron', 'dist', 'index.html');
      logger.info(`Trying activation from app path: ${p}`);
      await activationWindow.loadFile(p, { hash: '/activation' });
      logger.info('Loaded activation window from app path');
    } catch (err) {
      logger.error(`Failed to load activation window: ${err.message}`);
    }
  };

  loadActivationWindow().catch((err) => {
    logger.error(`Activation window load error: ${err.message}`);
  });

  activationWindow.once('ready-to-show', () => {
    activationWindow.show();
    activationWindow.focus();
  });

  activationWindow.on('closed', () => {
    activationWindow = null;
  });
}

// --- نافذة الـ Splash ---
function createSplashWindow() {
  if (splashWindow) return;

  splashWindow = new BrowserWindow({
    width: 1200,
    height: 650,
    resizable: false,
    frame: false,
    center: true,
    transparent: true,
    show: false,
    icon: isDev ? join(__dirname, '../../build/icon.png') : join(__dirname, '../build/icon.png'),
    webPreferences: {
      devTools: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.mjs'),
    },
  });

  splashWindow.webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL) => {
      logger.error(
        `Splash window failed to load: ${errorCode} - ${errorDescription} - ${validatedURL}`
      );
    }
  );

  splashWindow.webContents.on('did-finish-load', () => {
    logger.info('Splash window finished loading');
  });

  if (isDev) {
    splashWindow.loadFile(path.join(__dirname, '../../splash.html'));
  } else {
    const tryLoadSplash = async () => {
      try {
        const resourcesPath = process.resourcesPath;
        const splashPath = path.join(resourcesPath, 'dist-electron', 'dist', 'splash.html');
        logger.info(`Trying to load splash from resources path: ${splashPath}`);
        await splashWindow.loadFile(splashPath);
        logger.info('Successfully loaded splash from resources path');
        return;
      } catch (err) {
        logger.warn(`Failed to load splash from resources path: ${err.message}`);
      }

      try {
        const relativePath = path.join(__dirname, '../../dist/splash.html');
        logger.info(`Trying to load splash from relative path: ${relativePath}`);
        await splashWindow.loadFile(relativePath);
        logger.info('Successfully loaded splash from relative path');
        return;
      } catch (err) {
        logger.warn(`Failed to load splash from relative path: ${err.message}`);
      }

      let lastError;
      try {
        const appPath = app.getAppPath();
        const splashPath = path.join(appPath, 'dist-electron', 'dist', 'splash.html');
        logger.info(`Trying to load splash from app path: ${splashPath}`);
        await splashWindow.loadFile(splashPath);
        logger.info('Successfully loaded splash from app path');
        return;
      } catch (err) {
        lastError = err;
        logger.warn(`Failed to load splash from app path: ${err.message}`);
      }

      logger.error(
        `All splash path resolution strategies failed. Last error: ${lastError?.message || 'unknown'}`
      );
      throw new Error('Failed to locate splash.html file');
    };

    tryLoadSplash().catch((err) => {
      logger.error(`Failed to load splash.html after all attempts: ${err.message}`);
    });
  }

  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
    splashWindow.__shownAt = Date.now();
  });

  splashWindow.on('closed', () => (splashWindow = null));
}

function tryToShowMainWindowAfterSplash() {
  if (!mainWindow) return;
  if (!mainWindow.__readyToShow) return;
  if (!backendReady) return;

  if (splashTimeout) {
    clearTimeout(splashTimeout);
    splashTimeout = null;
  }

  const showMainWindow = () => {
    splashTimeout = null;

    if (splashWindow) {
      try {
        splashWindow.destroy();
      } catch (err) {
        logger.warn('Error destroying splash window', err);
      }
      splashWindow = null;
    }
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  };

  if (splashWindow && splashWindow.__shownAt) {
    const minSplashTime = 7000;
    const timeSinceShown = Date.now() - splashWindow.__shownAt;
    const timeLeft = minSplashTime - timeSinceShown;

    if (timeLeft > 0) {
      logger.info(`Splash shown. Waiting ${timeLeft}ms before showing main window`);
      splashTimeout = setTimeout(showMainWindow, timeLeft);
    } else {
      logger.info('Splash minimum time already reached, showing main window');
      showMainWindow();
    }
  } else {
    logger.warn('Splash timing not available, showing main window immediately');
    showMainWindow();
  }
}

// --- تشغيل التطبيق الرئيسي بعد التحقق من الترخيص ---
async function startNormalApp() {
  createSplashWindow();
  createWindow();
  try {
    await backendManager.StartBackend();
    backendReady = true;
  } catch (error) {
    logger.error('Failed to start backend, but continuing with UI:', error);
    backendReady = true;
  }
  tryToShowMainWindowAfterSplash();
}

// --- IPC: تفعيل الترخيص ---
ipcMain.handle('activate-license', async (_event, input) => {
  try {
    // input: { type: 'file', path: '...' } | { type: 'key', key: '...' }
    const licenseInput = input.type === 'file' ? input.path : input.key;
    const result = activate(licenseInput);

    if (result.valid) {
      logger.info('License activated successfully');

      // Start the main app FIRST so at least one window exists before
      // the activation window is destroyed — otherwise window-all-closed
      // fires with zero windows and the app quits before the main window opens.
      await startNormalApp();

      if (activationWindow && !activationWindow.isDestroyed()) {
        activationWindow.destroy();
        activationWindow = null;
      }

      return { success: true, license: result.license };
    } else {
      logger.warn('License activation failed:', result.error);
      return { success: false, error: result.error, details: result.details };
    }
  } catch (err) {
    logger.error('License activation error:', err);
    return { success: false, error: err.message };
  }
});

// --- IPC: فتح مربع حوار لاختيار ملف الترخيص ---
ipcMain.handle('license:browseFile', async () => {
  const result = await dialog.showOpenDialog(activationWindow || null, {
    title: 'اختر ملف الترخيص',
    filters: [{ name: 'License File', extensions: ['lic', 'json'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return { canceled: false, filePath: result.filePaths[0] };
});

// --- IPC: معرّف الجهاز (للعرض في نافذة التفعيل فقط) ---
ipcMain.handle('license:getMachineId', () => {
  try {
    return { success: true, machineId: getMachineId() };
  } catch (err) {
    logger.error('Failed to get machine ID:', err);
    return { success: false, machineId: null };
  }
});

app.whenReady().then(async () => {
  if (isQuitting) return;

  // --- التحقق من الترخيص قبل فتح أي نافذة ---
  let licenseValid = false;
  try {
    const result = checkStored();
    licenseValid = result.valid;
    if (!result.valid) {
      logger.warn(`License check failed: ${result.error}`);
    } else {
      logger.info('License is valid, starting app normally');
    }
  } catch (err) {
    logger.error(`License check threw: ${err.message}`);
    licenseValid = false;
  }

  if (licenseValid) {
    await startNormalApp();
  } else {
    createActivationWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
      if (mainWindow === null && activationWindow === null) {
        createActivationWindow();
      }
    }
  });
});

// --- عند إغلاق جميع النوافذ ---
app.on('window-all-closed', async () => {
  isQuitting = true;
  await backendManager.CleanupBackendProcess();
  app.quit();
});

// --- before quit ---
app.on('before-quit', async (event) => {
  if (isQuitting) return;

  isQuitting = true;
  event.preventDefault();

  if (splashTimeout) {
    clearTimeout(splashTimeout);
    splashTimeout = null;
  }

  await backendManager.CleanupBackendProcess();
  app.quit();
});

// --- will quit ---
app.on('will-quit', async () => {
  await backendManager.CleanupBackendProcess();
});

// --- IPC: معلومات التطبيق ---
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:getPlatform', () => process.platform);

// --- Dialog ---
ipcMain.handle('dialog:showSaveDialog', async (_e, options) =>
  dialog.showSaveDialog(mainWindow, options)
);

ipcMain.handle('dialog:showOpenDialog', async (_e, options) =>
  dialog.showOpenDialog(mainWindow, options)
);

// --- File System ---
ipcMain.handle('file:saveFile', async (_e, filePath, data) => {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  await fs.writeFile(filePath, buffer);
  return { success: true };
});

ipcMain.handle('file:readFile', async (_e, filePath) => {
  return await fs.readFile(filePath);
});

// --- التحكم في backend (يدوي فقط) ---
ipcMain.handle('backend:start', async () => {
  await backendManager.StartBackend();
  return { ok: true };
});

ipcMain.handle('backend:stop', async () => {
  await backendManager.CleanupBackendProcess();
  return { ok: true };
});

ipcMain.handle('backend:restart', async () => {
  await backendManager.CleanupBackendProcess();
  await backendManager.StartBackend();
  return { ok: true };
});

// --- استعادة النسخة الاحتياطية ---
ipcMain.handle('backup:restore', async (_e, filename) => {
  try {
    const os = await import('os');
    const path = await import('path');

    const getUserDataDir = () => {
      const platform = process.platform;
      const homeDir = os.homedir();

      if (platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Roaming', '@nuqtaplus');
      } else if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', '@nuqtaplus');
      } else {
        return path.join(homeDir, '.config', '@nuqtaplus');
      }
    };

    const userDataDir = getUserDataDir();
    const dbPath = path.join(userDataDir, 'database', 'nuqtaplus.db');
    const backupDir = path.join(userDataDir, 'database', 'backups');
    const backupPath = path.join(backupDir, filename);

    logger.info(`Restoring backup from: ${backupPath} to ${dbPath}`);

    try {
      await fs.access(backupPath);
    } catch {
      throw new Error('ملف النسخة الاحتياطية غير موجود');
    }

    logger.info('Stopping backend for restore...');
    await backendManager.CleanupBackendProcess();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    logger.info('Copying backup file...');
    await fs.copyFile(backupPath, dbPath);

    logger.info('Restarting backend...');
    await backendManager.StartBackend();
    backendReady = true;

    return { ok: true };
  } catch (error) {
    logger.error('Failed to restore backup:', error);
    try {
      if (!backendManager.isRunning()) {
        await backendManager.StartBackend();
      }
    } catch (e) {
      logger.error('Failed to recover backend after failed restore:', e);
    }

    return { ok: false, error: error.message };
  }
});

// --- تصدير النسخة الاحتياطية ---
ipcMain.handle('backup:export', async (_e, filename) => {
  try {
    const os = await import('os');
    const path = await import('path');

    const getUserDataDir = () => {
      const platform = process.platform;
      const homeDir = os.homedir();

      if (platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Roaming', '@nuqtaplus');
      } else if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', '@nuqtaplus');
      } else {
        return path.join(homeDir, '.config', '@nuqtaplus');
      }
    };

    const userDataDir = getUserDataDir();
    const backupDir = path.join(userDataDir, 'database', 'backups');
    const sourcePath = path.join(backupDir, filename);

    try {
      await fs.access(sourcePath);
    } catch {
      throw new Error('ملف النسخة الاحتياطية غير موجود');
    }

    const { canceled, filePath: destPath } = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ النسخة الاحتياطية',
      defaultPath: filename,
      filters: [{ name: 'Database Backup', extensions: ['db'] }],
    });

    if (canceled || !destPath) {
      return { ok: false, reason: 'canceled' };
    }

    await fs.copyFile(sourcePath, destPath);

    return { ok: true };
  } catch (error) {
    logger.error('Failed to export backup:', error);
    return { ok: false, error: error.message };
  }
});

// --- تصدير النسخة الاحتياطية مع تصفير قاعدة البيانات ---
ipcMain.handle('backup:exportAndCreateNewDatabase', async (_e) => {
  try {
    const os = await import('os');
    const path = await import('path');

    const homeDir = os.homedir();
    const userDataDir = path.join(homeDir, 'AppData', 'Roaming', '@nuqtaplus');
    const dbDir = path.join(userDataDir, 'database');

    const dbPath = path.join(dbDir, 'nuqtaplus.db');

    const saveLocation = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ النسخة الاحتياطية',
      defaultPath: `nuqtaplus-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'Database Backup', extensions: ['db'] }],
    });

    if (saveLocation.canceled || !saveLocation.filePath) {
      return { ok: false, reason: 'canceled' };
    }

    await fs.copyFile(dbPath, saveLocation.filePath);

    logger.info('Stopping backend for new database creation...');
    await backendManager.CleanupBackendProcess();

    logger.info('Deleting current database file...');
    await fs.unlink(dbPath, { recursive: true });

    logger.info('New database will be created on next backend start.');

    BrowserWindow.getAllWindows().forEach((win) => win.destroy());
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (error) {
    logger.error('Failed to export backup and create new database:', error);
    return { ok: false, error: error.message };
  } finally {
    try {
      if (!backendManager.isRunning()) {
        logger.info('Restarting backend after new database creation...');
        await backendManager.StartBackend();
        backendReady = true;
      }
    } catch (e) {
      logger.error('Failed to restart backend after new database creation:', e);
    }
  }
});

// --- فتح رابط خارجي ---
ipcMain.handle('shell:openExternal', async (_e, url) => {
  await shell.openExternal(url);
  return { success: true };
});

ipcMain.handle('update:check', () => {
  checkForUpdates(true);
});

ipcMain.handle('update:download', () => {
  startDownload();
});

// ---- First Run Setup ----
ipcMain.handle('firstRun:createLock', () => {
  try {
    createLockFile();
    logger.info('Lock file created successfully');
    return { success: true };
  } catch (error) {
    logger.error('Failed to create lock file:', error);
    return { success: false, error: error.message };
  }
});
