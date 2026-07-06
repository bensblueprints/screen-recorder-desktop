const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let mainWindow = null;
let overlayWindow = null;
let selectedSourceId = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function libraryDir() {
  const dir = path.join(app.getPath('videos'), 'Screen Recorder');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function thumbsDir() {
  const dir = path.join(libraryDir(), '.thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-y', '-hide_banner', ...args], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
      if (onProgress) {
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(d.toString());
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

function ffprobeDuration(file) {
  // ffmpeg-static ships no ffprobe; parse duration from ffmpeg -i stderr.
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-t', '0.1', '-'], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
      if (m && m[1] !== 'N/A') {
        resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      } else resolve(null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function ensureThumbnail(videoPath) {
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
  const thumb = path.join(thumbsDir(), base + '.jpg');
  if (fs.existsSync(thumb)) return thumb;
  try {
    await runFfmpeg(['-ss', '0.3', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '4', thumb]);
    return fs.existsSync(thumb) ? thumb : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'Screen Recorder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createOverlay() {
  if (overlayWindow) return;
  overlayWindow = new BrowserWindow({
    width: 176,
    height: 52,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  overlayWindow.setPosition(workArea.x + workArea.width - 196, workArea.y + workArea.height - 76);
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function destroyOverlay() {
  if (overlayWindow) { overlayWindow.destroy(); overlayWindow = null; }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 250 },
    fetchWindowIcons: false
  });
  return sources
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL()
    }));
});

ipcMain.on('capture:select-source', (_e, id) => { selectedSourceId = id; });

ipcMain.on('recording:started', () => { createOverlay(); });
ipcMain.on('recording:stopped', () => { destroyOverlay(); });
ipcMain.on('overlay:stop-clicked', () => {
  destroyOverlay();
  if (mainWindow) {
    mainWindow.webContents.send('recording:stop-requested');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });

ipcMain.handle('recording:save', async (_e, arrayBuffer) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(libraryDir(), `recording-${stamp}.webm`);
  fs.writeFileSync(file, Buffer.from(arrayBuffer));
  await ensureThumbnail(file);
  return file;
});

ipcMain.handle('library:list', async () => {
  const dir = libraryDir();
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(webm|mp4|gif)$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { path: full, name: f, size: st.size, mtime: st.mtimeMs, ext: path.extname(f).slice(1).toLowerCase() };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const item of files) {
    if (item.ext !== 'gif') {
      const t = await ensureThumbnail(item.path);
      item.thumbnail = t ? 'file:///' + t.replace(/\\/g, '/') : null;
    } else {
      item.thumbnail = 'file:///' + item.path.replace(/\\/g, '/');
    }
    item.url = 'file:///' + item.path.replace(/\\/g, '/');
  }
  return files;
});

ipcMain.handle('library:delete', async (_e, filePath) => {
  const dir = libraryDir();
  if (!path.normalize(filePath).startsWith(path.normalize(dir))) throw new Error('Refusing to delete outside library');
  fs.rmSync(filePath, { force: true });
  const thumb = path.join(thumbsDir(), path.basename(filePath).replace(/\.[^.]+$/, '') + '.jpg');
  fs.rmSync(thumb, { force: true });
  return true;
});

ipcMain.handle('library:open-folder', async () => {
  await shell.openPath(libraryDir());
  return true;
});

ipcMain.handle('library:reveal', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('media:duration', async (_e, filePath) => ffprobeDuration(filePath));

ipcMain.handle('export:run', async (e, opts) => {
  const { input, format, trimStart, trimEnd } = opts;
  const inDur = await ffprobeDuration(input);
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null && Number(trimEnd) > start ? Number(trimEnd) : inDur;
  const outDur = end != null ? Math.max(0.1, end - start) : null;

  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const suffix = start > 0 || (inDur && end && end < inDur - 0.05) ? '-trim' : '';
  let output = path.join(libraryDir(), `${base}${suffix}.${format}`);
  let n = 1;
  while (fs.existsSync(output)) output = path.join(libraryDir(), `${base}${suffix}-${n++}.${format}`);

  const sendProgress = (secs) => {
    if (outDur) e.sender.send('export:progress', { output, percent: Math.min(99, Math.round((secs / outDur) * 100)) });
  };

  const trimArgs = ['-ss', String(start), '-i', input];
  if (outDur != null) trimArgs.push('-t', String(outDur));

  if (format === 'mp4') {
    await runFfmpeg([
      ...trimArgs,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      output
    ], sendProgress);
  } else if (format === 'gif') {
    const palette = path.join(app.getPath('temp'), `sr-palette-${Date.now()}.png`);
    const scale = 'fps=12,scale=960:-1:flags=lanczos';
    try {
      await runFfmpeg([...trimArgs, '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
      await runFfmpeg([
        ...trimArgs, '-i', palette,
        '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        output
      ], sendProgress);
    } finally {
      fs.rmSync(palette, { force: true });
    }
  } else {
    throw new Error('Unknown format: ' + format);
  }

  e.sender.send('export:progress', { output, percent: 100 });
  return { output, size: fs.statSync(output).size };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // Route getDisplayMedia to the source picked in our own UI.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === selectedSourceId) || sources[0];
      callback({ video: source, audio: 'loopback' });
    } catch (err) {
      console.error('display media handler failed:', err);
      callback({});
    }
  });

  // Smoke-boot mode: log capture sources and exit (used by verification).
  if (process.env.SMOKE_BOOT) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      console.log(`[smoke-boot] desktopCapturer returned ${sources.length} source(s):`);
      sources.slice(0, 10).forEach((s) => console.log(`  - [${s.id}] ${s.name}`));
    } catch (err) {
      console.error('[smoke-boot] desktopCapturer FAILED:', err);
      app.exit(1);
      return;
    }
    createMainWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[smoke-boot] renderer loaded OK, exiting.');
      setTimeout(() => app.exit(0), 500);
    });
    return;
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
