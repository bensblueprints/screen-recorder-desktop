const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let mainWindow = null;
let overlayWindow = null;
let selectedSourceId = null;
let streamProc = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

function writeSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {}
}

function defaultOutputDir() {
  return path.join(app.getPath('videos'), 'BloomRecorder');
}

function libraryDir() {
  const s = readSettings();
  const dir = s.outputDir || defaultOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function thumbsDir() {
  const dir = path.join(libraryDir(), '.thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaDir() {
  const dir = path.join(libraryDir(), '.meta');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Scratch dir for intermediate ffmpeg outputs, kept inside the library dir
// so the final move is always a same-volume rename (avoids EXDEV — the
// library dir can be junctioned to a different physical drive than the OS
// temp dir on this machine, which made os-temp rename targets fail).
function tmpWorkDir() {
  const dir = path.join(libraryDir(), '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Falls back to copy+delete if src/dest ever do end up on different volumes
// (e.g. output dir gets changed to another drive later).
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
}

function baseName(videoPath) {
  return path.basename(videoPath).replace(/\.[^.]+$/, '');
}

function metaFile(videoPath) {
  return path.join(metaDir(), baseName(videoPath) + '.json');
}

function readMeta(videoPath) {
  try { return JSON.parse(fs.readFileSync(metaFile(videoPath), 'utf8')); } catch { return {}; }
}

function writeMeta(videoPath, patch) {
  const merged = { ...readMeta(videoPath), ...patch };
  fs.writeFileSync(metaFile(videoPath), JSON.stringify(merged, null, 2));
  return merged;
}

function transcriptFile(videoPath) {
  return path.join(metaDir(), baseName(videoPath) + '.transcript.json');
}

function readTranscript(videoPath) {
  try { return JSON.parse(fs.readFileSync(transcriptFile(videoPath), 'utf8')); } catch { return null; }
}

function writeTranscript(videoPath, data) {
  fs.writeFileSync(transcriptFile(videoPath), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
function runFfmpeg(args, onProgress, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-y', '-hide_banner', ...args], { windowsHide: true, ...(cwd ? { cwd } : {}) });
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

function ffprobeResolution(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-t', '0.1', '-'], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(out);
      resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
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
// Local transcription (Whisper, via @huggingface/transformers / ONNX runtime)
// ---------------------------------------------------------------------------
let asrPipelinePromise = null;

function getAsrPipeline(onModelProgress) {
  if (!asrPipelinePromise) {
    asrPipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(app.getPath('userData'), 'models');
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', {
        dtype: 'q8',
        progress_callback: onModelProgress
      });
    })();
  }
  return asrPipelinePromise;
}

// Decode to 16kHz mono float32 PCM — the sample format Whisper expects.
function extractPcm16k(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-f', 'f32le', '-ac', '1', '-ar', '16000',
      'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg PCM extract failed: ${stderr.slice(-500)}`)); return; }
      const buf = Buffer.concat(chunks);
      // ArrayBuffer.slice() always starts at byte 0, guaranteeing 4-byte alignment for Float32Array.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
      resolve(new Float32Array(ab));
    });
  });
}

// Transcribes once, caches word-level timestamps to a sidecar so captions
// and the reel-clipper can both reuse the same run.
async function transcribeVideo(videoPath, onProgress) {
  const cached = readTranscript(videoPath);
  if (cached) return cached;

  if (onProgress) onProgress({ phase: 'decoding-audio' });
  const audio = await extractPcm16k(videoPath);

  const transcriber = await getAsrPipeline((p) => {
    if (onProgress && p && p.status === 'progress') {
      onProgress({ phase: 'downloading-model', file: p.file, percent: Math.round(p.progress || 0) });
    }
  });

  if (onProgress) onProgress({ phase: 'transcribing' });
  const result = await transcriber(audio, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5
  });

  const words = (result.chunks || [])
    .map((c) => ({
      text: c.text.trim(),
      start: c.timestamp[0],
      end: c.timestamp[1] != null ? c.timestamp[1] : c.timestamp[0] + 0.3
    }))
    .filter((w) => w.text);

  const transcript = { text: (result.text || '').trim(), words };
  writeTranscript(videoPath, transcript);
  if (onProgress) onProgress({ phase: 'done' });
  return transcript;
}

// Groups word-level timestamps into caption cues. 'word' = one word on
// screen at a time (TikTok/Reels style); 'line' (default) = short phrases,
// ~4-6 words / ~2.2s max.
function transcriptToCues(transcript, mode) {
  if (mode === 'word') {
    return transcript.words.map((w) => ({ start: w.start, end: Math.max(w.end, w.start + 0.25), text: w.text }));
  }
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of transcript.words) {
    cur.push(w);
    const span = cur[cur.length - 1].end - cur[0].start;
    if (cur.length >= 6 || span >= 2.2 || /[.!?]$/.test(w.text)) flush();
  }
  flush();
  return cues;
}

// Caption style templates. Colours are ASS &HAABBGGRR (alpha, blue, green,
// red) hex. NOTE: ffmpeg's `subtitles` filter force_style option is broken
// in the bundled ffmpeg-static build (verified: identical output with and
// without it, even against a hand-authored .ass file with a distinguishable
// baseline) — so instead of relying on force_style, buildAssDocument() bakes
// the chosen look/size/position directly into a real .ass Style line and we
// burn that in with no force_style at all.
const CAPTION_STYLES = {
  classic: { fontName: 'Arial', primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: 1, borderStyle: 1, outlineWidth: 2, shadow: 0 },
  'bold-yellow': { fontName: 'Arial Black', primary: '&H0000FFFF', outline: '&H00000000', back: '&H00000000', bold: 1, borderStyle: 1, outlineWidth: 3, shadow: 0 },
  'black-box': { fontName: 'Arial', primary: '&H0000FFFF', outline: '&H00000000', back: '&H00000000', bold: 1, borderStyle: 3, outlineWidth: 6, shadow: 0 },
  'yellow-outline': { fontName: 'Arial Black', primary: '&H00FFFFFF', outline: '&H0000FFFF', back: '&H00000000', bold: 1, borderStyle: 1, outlineWidth: 4, shadow: 0 }
};
const DEFAULT_CAPTION_STYLE = 'classic';

// ASS alignment is numpad-style: 1/2/3 = bottom L/C/R, 4/5/6 = middle, 7/8/9 = top.
// Captions are always horizontally centered; position picks the vertical anchor.
const CAPTION_POSITIONS = {
  top: { alignment: 8, marginV: 40 },
  middle: { alignment: 5, marginV: 0 },
  bottom: { alignment: 2, marginV: 60 }
};
const DEFAULT_CAPTION_POSITION = 'bottom';
const MIN_CAPTION_SIZE = 14;
const MAX_CAPTION_SIZE = 56;
const DEFAULT_CAPTION_SIZE = 22;

function assTimestamp(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escapeAssText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

// videoW/videoH set PlayResX/PlayResY to the real video's resolution so
// FontSize/MarginV land in actual video pixels instead of ffmpeg's default
// 384x288 reference frame (the other half of why captions showed up at the
// wrong size/position — that default applied regardless of force_style).
function buildAssDocument(cues, styleKey, positionKey, fontSize, videoW, videoH) {
  const look = CAPTION_STYLES[styleKey] || CAPTION_STYLES[DEFAULT_CAPTION_STYLE];
  const pos = CAPTION_POSITIONS[positionKey] || CAPTION_POSITIONS[DEFAULT_CAPTION_POSITION];
  const size = Math.min(MAX_CAPTION_SIZE, Math.max(MIN_CAPTION_SIZE, Math.round(Number(fontSize)) || DEFAULT_CAPTION_SIZE));
  const w = videoW || 1920;
  const h = videoH || 1080;

  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${look.fontName},${size},${look.primary},&H000000FF,${look.outline},${look.back},${look.bold},0,0,0,100,100,0,0,${look.borderStyle},${look.outlineWidth},${look.shadow},${pos.alignment},10,10,${pos.marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const events = cues
    .map((c) => `Dialogue: 0,${assTimestamp(c.start)},${assTimestamp(c.end)},Default,,0,0,0,,${escapeAssText(c.text)}`)
    .join('\n');

  return header + events + '\n';
}

// ---------------------------------------------------------------------------
// "Make Reels" — local heuristic viral-moment scoring
//
// This is NOT a virality predictor. It's a transcript/pace heuristic: words
// that read as hooks (curiosity/urgency/superlatives), sentence-ending
// emphasis (! / ?), dramatic pauses, and above-average speaking pace all
// nudge a window's score up. It surfaces candidate moments worth a look —
// nothing more.
// ---------------------------------------------------------------------------
const REEL_HOOK_WORDS = new Set([
  'secret', 'secretly', 'never', 'always', 'biggest', 'worst', 'best', 'mistake', 'mistakes',
  'nobody', 'everyone', 'crazy', 'insane', 'unbelievable', 'wow', 'stop', 'wait', 'listen',
  'actually', 'literally', 'honestly', 'free', 'guarantee', 'guaranteed', 'hack', 'trick',
  'warning', 'shocking', 'truth', 'lie', 'lied', 'scam', 'rich', 'money', 'million', 'billion',
  'failed', 'fail', 'win', 'winning', 'hate', 'love', 'scared', 'afraid', 'danger', 'dangerous',
  'proven', 'instantly', 'exposed', 'revealed', 'banned', 'illegal', 'why', 'how'
]);

function cleanWord(w) {
  return w.toLowerCase().replace(/^[^a-z0-9%]+|[^a-z0-9%]+$/gi, '');
}

function scoreWords(words) {
  return words.map((w, i) => {
    let score = 0;
    const clean = cleanWord(w.text);
    if (REEL_HOOK_WORDS.has(clean)) score += 2;
    if (/%$/.test(clean) || /^\d+$/.test(clean)) score += 1;
    if (/[!?]$/.test(w.text.trim())) score += 1;
    if (i > 0) {
      const gap = w.start - words[i - 1].end;
      if (gap > 0.5 && gap < 3) score += 1; // dramatic pause leading into this word
    }
    return score;
  });
}

// Slides a window sized for the target clip length across the transcript and
// scores each position by hook density + how much faster-than-average the
// speaker is talking in that window.
function scoreReelWindows(transcript, maxLength) {
  const words = transcript.words;
  if (!words.length) return [];
  const wordScores = scoreWords(words);
  const totalDur = words[words.length - 1].end;
  const overallPace = words.length / Math.max(1, totalDur);
  const target = Math.max(6, Math.min(maxLength - 2, maxLength * 0.85));
  const stepSec = 2;

  const candidates = [];
  for (let t = 0; t + target <= totalDur; t += stepSec) {
    const windowEnd = t + target;
    let idxStart = -1, idxEnd = -1, hookSum = 0, count = 0;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start >= t && words[i].end <= windowEnd) {
        if (idxStart === -1) idxStart = i;
        idxEnd = i;
        hookSum += wordScores[i];
        count++;
      }
    }
    if (count < 4) continue;
    const pace = count / target;
    const paceScore = Math.max(0, (pace - overallPace) / Math.max(0.1, overallPace));
    candidates.push({ start: words[idxStart].start, end: words[idxEnd].end, score: hookSum + paceScore * 3 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// Greedily takes the highest-scoring windows, skipping any that overlap
// (with a 1s buffer) an already-picked clip — "as many as it can find".
function pickNonOverlapping(candidates, maxClips) {
  const picked = [];
  for (const c of candidates) {
    if (picked.some((p) => c.start < p.end + 1 && c.end > p.start - 1)) continue;
    picked.push(c);
    if (picked.length >= maxClips) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

// Reframes to 9:16 via a centered scale+crop — same technique as Build Short.
async function cutReelClip(input, ssStart, duration, output, onProgress) {
  await runFfmpeg([
    '-ss', String(Math.max(0, ssStart)),
    '-i', input,
    '-t', String(duration),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output
  ], onProgress);
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
    title: 'BloomRecorder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
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
ipcMain.on('overlay:pause-toggle-clicked', () => {
  if (mainWindow) mainWindow.webContents.send('recording:pause-toggle-requested');
});
ipcMain.on('overlay:set-paused', (_e, paused) => {
  if (overlayWindow) overlayWindow.webContents.send('overlay:paused-state', paused);
});
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });

ipcMain.on('shell:open-external', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('recording:save', async (_e, arrayBuffer, label, sharedStamp) => {
  const stamp = sharedStamp || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const suffix = label ? '-' + String(label).replace(/[^a-z0-9_-]/gi, '') : '';
  let file = path.join(libraryDir(), `recording-${stamp}${suffix}.webm`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(libraryDir(), `recording-${stamp}${suffix}-${n++}.webm`);
  fs.writeFileSync(file, Buffer.from(arrayBuffer));
  await ensureThumbnail(file);
  return file;
});

ipcMain.handle('settings:get', async () => {
  const s = readSettings();
  return { outputDir: s.outputDir || defaultOutputDir() };
});

ipcMain.handle('settings:choose-output-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where recordings are saved',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const s = readSettings();
  s.outputDir = res.filePaths[0];
  writeSettings(s);
  fs.mkdirSync(s.outputDir, { recursive: true });
  return s.outputDir;
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
  // Thumbnail generation spawns an ffmpeg process per missing thumb — with a
  // big batch of new files (e.g. a Make Reels run) doing this one-at-a-time
  // made the whole library view feel frozen. Run with bounded concurrency.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const item = files[cursor++];
      if (item.ext !== 'gif') {
        const t = await ensureThumbnail(item.path);
        item.thumbnail = t ? 'file:///' + t.replace(/\\/g, '/') : null;
      } else {
        item.thumbnail = 'file:///' + item.path.replace(/\\/g, '/');
      }
      item.url = 'file:///' + item.path.replace(/\\/g, '/');
      const meta = readMeta(item.path);
      item.captioned = !!meta.captioned;
      item.isReel = !!meta.isReel;
      item.parent = meta.parent || null;
      item.hasTranscript = fs.existsSync(transcriptFile(item.path));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return files;
});

// Windows can briefly hold a file lock right after a <video> element that had
// it open gets unloaded — retry a few times instead of failing immediately.
async function rmWithRetry(filePath, attempts = 6, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

ipcMain.handle('library:delete', async (_e, filePath) => {
  const dir = libraryDir();
  if (!path.normalize(filePath).startsWith(path.normalize(dir))) throw new Error('Refusing to delete outside library');
  await rmWithRetry(filePath);
  const thumb = path.join(thumbsDir(), path.basename(filePath).replace(/\.[^.]+$/, '') + '.jpg');
  fs.rmSync(thumb, { force: true });
  fs.rmSync(metaFile(filePath), { force: true });
  fs.rmSync(transcriptFile(filePath), { force: true });
  return true;
});

ipcMain.handle('library:rename', async (_e, filePath, newBaseName) => {
  const dir = libraryDir();
  if (!path.normalize(filePath).startsWith(path.normalize(dir))) throw new Error('Refusing to rename outside library');
  const safe = String(newBaseName).replace(/[\\/:*?"<>|]/g, '').trim();
  if (!safe) throw new Error('Invalid name');

  const ext = path.extname(filePath);
  let dest = path.join(dir, safe + ext);
  let n = 1;
  while (fs.existsSync(dest) && path.normalize(dest) !== path.normalize(filePath)) {
    dest = path.join(dir, `${safe}-${n++}${ext}`);
  }
  if (path.normalize(dest) === path.normalize(filePath)) return filePath;

  const oldBase = baseName(filePath);
  const newBase = baseName(dest);

  fs.renameSync(filePath, dest);

  const oldThumb = path.join(thumbsDir(), oldBase + '.jpg');
  if (fs.existsSync(oldThumb)) fs.renameSync(oldThumb, path.join(thumbsDir(), newBase + '.jpg'));

  const oldMetaPath = path.join(metaDir(), oldBase + '.json');
  if (fs.existsSync(oldMetaPath)) fs.renameSync(oldMetaPath, path.join(metaDir(), newBase + '.json'));

  const oldTranscriptPath = path.join(metaDir(), oldBase + '.transcript.json');
  if (fs.existsSync(oldTranscriptPath)) fs.renameSync(oldTranscriptPath, path.join(metaDir(), newBase + '.transcript.json'));

  // Keep any derivative files' "parent" links pointing at the new filename.
  const oldFileName = path.basename(filePath);
  const newFileName = path.basename(dest);
  for (const f of fs.readdirSync(metaDir())) {
    if (!f.endsWith('.json') || f.endsWith('.transcript.json')) continue;
    const full = path.join(metaDir(), f);
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (m.parent === oldFileName) {
        m.parent = newFileName;
        fs.writeFileSync(full, JSON.stringify(m, null, 2));
      }
    } catch {}
  }

  return dest;
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

ipcMain.handle('captions:transcribe', async (e, filePath) => {
  return transcribeVideo(filePath, (p) => e.sender.send('captions:progress', p));
});

ipcMain.handle('captions:burn', async (e, opts) => {
  const { input, replace, style, mode, position, fontSize } = opts;
  const dir = libraryDir();
  const base = baseName(input);

  const transcript = await transcribeVideo(input, (p) => e.sender.send('captions:progress', p));
  const cues = transcriptToCues(transcript, mode);
  if (!cues.length) throw new Error('No speech detected to caption');

  const [inDur, videoRes] = await Promise.all([ffprobeDuration(input), ffprobeResolution(input)]);
  const assDoc = buildAssDocument(cues, style, position, fontSize, videoRes && videoRes.width, videoRes && videoRes.height);

  const work = tmpWorkDir();
  const assName = `captions-${Date.now()}.ass`;
  fs.writeFileSync(path.join(work, assName), assDoc, 'utf8');

  const tempOut = path.join(work, `captioned-${Date.now()}.mp4`);
  const sendProgress = (secs) => {
    if (inDur) e.sender.send('captions:progress', { phase: 'burning', percent: Math.min(99, Math.round((secs / inDur) * 100)) });
  };

  try {
    // ffmpeg's subtitles filter mis-parses a drive-letter colon inside its
    // own option string regardless of quoting/escaping — running with cwd
    // set to the .ass file's own directory and referencing it by bare name
    // sidesteps that entirely (input/output paths below are unaffected
    // since they're plain argv, not embedded in a -vf filter string).
    await runFfmpeg([
      '-i', input,
      '-vf', `subtitles=${assName}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      tempOut
    ], sendProgress, work);
  } finally {
    fs.rmSync(path.join(work, assName), { force: true });
  }

  let output;
  if (replace) {
    const priorMeta = readMeta(input);
    const priorMetaPath = metaFile(input);
    const priorTranscriptPath = transcriptFile(input);

    fs.rmSync(input, { force: true });
    fs.rmSync(path.join(thumbsDir(), base + '.jpg'), { force: true });

    output = path.join(dir, base + '.mp4');
    let n = 1;
    while (fs.existsSync(output)) output = path.join(dir, `${base}-${n++}.mp4`);
    moveFile(tempOut, output);

    if (metaFile(output) !== priorMetaPath) fs.rmSync(priorMetaPath, { force: true });
    if (transcriptFile(output) !== priorTranscriptPath) fs.rmSync(priorTranscriptPath, { force: true });
    writeMeta(output, { ...priorMeta, captioned: true });
    writeTranscript(output, transcript);
  } else {
    output = path.join(dir, `${base}-captioned.mp4`);
    let n = 1;
    while (fs.existsSync(output)) output = path.join(dir, `${base}-captioned-${n++}.mp4`);
    moveFile(tempOut, output);
    writeMeta(output, { captioned: true, parent: path.basename(input) });
    writeTranscript(output, transcript);
  }

  await ensureThumbnail(output);
  e.sender.send('captions:progress', { phase: 'done' });
  return { output, size: fs.statSync(output).size };
});

const REEL_MAX_CLIPS = 20; // sane ceiling on a single "make as many as it can" pass

ipcMain.handle('reels:make', async (e, opts) => {
  const { input, maxLength } = opts;
  const cap = [15, 30, 60].includes(Number(maxLength)) ? Number(maxLength) : 30;
  const dir = libraryDir();
  const base = baseName(input);

  const transcript = await transcribeVideo(input, (p) => e.sender.send('reels:progress', p));
  e.sender.send('reels:progress', { phase: 'scoring' });

  // Require at least one real signal (a hook word, or two weaker ones combined) —
  // pace variance alone on flat/filler delivery shouldn't count as a "moment".
  const candidates = scoreReelWindows(transcript, cap).filter((c) => c.score >= 2);
  const picked = pickNonOverlapping(candidates, REEL_MAX_CLIPS);

  const clips = [];
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    const ssStart = Math.max(0, c.start - 0.2);
    const duration = Math.min(cap, c.end + 0.4 - ssStart);

    let output = path.join(dir, `${base}-reel-${i + 1}.mp4`);
    let n = 1;
    while (fs.existsSync(output)) output = path.join(dir, `${base}-reel-${i + 1}-${n++}.mp4`);

    await cutReelClip(input, ssStart, duration, output, (secs) => {
      e.sender.send('reels:progress', {
        phase: 'cutting', index: i + 1, total: picked.length,
        percent: Math.min(99, Math.round((secs / duration) * 100))
      });
    });

    writeMeta(output, { isReel: true, parent: path.basename(input) });
    await ensureThumbnail(output);
    clips.push({ output, size: fs.statSync(output).size, start: ssStart, end: ssStart + duration, score: c.score });
  }

  e.sender.send('reels:progress', { phase: 'done' });
  return { clips, consideredCandidates: candidates.length, cappedAt: REEL_MAX_CLIPS };
});

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

// Screen + camera files saved from a split "both" recording share the same
// timestamp stamp, e.g. recording-2026-07-09-12-00-00-screen.webm /
// ...-camera.webm — that's how we find the sibling to build a Short from.
function findPairedFile(filePath) {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const m = /^(recording-[\d-]+)-(screen|camera)(\.webm)$/.exec(name);
  if (!m) return null;
  const [, base, label, ext] = m;
  const otherLabel = label === 'screen' ? 'camera' : 'screen';
  const otherPath = path.join(dir, `${base}-${otherLabel}${ext}`);
  return fs.existsSync(otherPath) ? { screenPath: label === 'screen' ? filePath : otherPath, cameraPath: label === 'camera' ? filePath : otherPath, base } : null;
}

ipcMain.handle('library:find-pair', async (_e, filePath) => {
  const pair = findPairedFile(filePath);
  return pair ? { screenPath: pair.screenPath, cameraPath: pair.cameraPath } : null;
});

ipcMain.handle('shorts:build', async (e, opts) => {
  const { screenPath, cameraPath, cameraOnTop } = opts;
  const base = path.basename(screenPath).replace(/-screen\.webm$/, '');
  let output = path.join(libraryDir(), `${base}-short.mp4`);
  let n = 1;
  while (fs.existsSync(output)) output = path.join(libraryDir(), `${base}-short-${n++}.mp4`);

  const topPath = cameraOnTop ? cameraPath : screenPath;
  const bottomPath = cameraOnTop ? screenPath : cameraPath;
  const audioIdx = cameraOnTop ? 1 : 0; // prefer the screen track's audio (full mixed mic+system)

  const screenDur = await ffprobeDuration(screenPath);
  const camDur = await ffprobeDuration(cameraPath);
  const outDur = Math.min(screenDur || Infinity, camDur || Infinity);
  const sendProgress = (secs) => {
    if (outDur && Number.isFinite(outDur)) e.sender.send('shorts:progress', { output, percent: Math.min(99, Math.round((secs / outDur) * 100)) });
  };

  await runFfmpeg([
    '-i', topPath,
    '-i', bottomPath,
    '-filter_complex',
    '[0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top];' +
    '[1:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[bottom];' +
    '[top][bottom]vstack=inputs=2[v]',
    '-map', '[v]', '-map', `${audioIdx}:a?`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-shortest',
    output
  ], sendProgress);

  e.sender.send('shorts:progress', { output, percent: 100 });
  await ensureThumbnail(output);
  return { output, size: fs.statSync(output).size };
});

// ---------------------------------------------------------------------------
// Live streaming (RTMP)
// ---------------------------------------------------------------------------
ipcMain.handle('stream:start', async (e, opts) => {
  if (streamProc) throw new Error('A stream is already live');
  const { target } = opts;
  if (!target) throw new Error('Missing RTMP target');

  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'webm', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
    '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-f', 'flv', target
  ], { windowsHide: true });

  streamProc = proc;
  let stderr = '';

  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });

  proc.on('error', (err) => {
    if (streamProc === proc) streamProc = null;
    if (mainWindow) mainWindow.webContents.send('stream:status', { type: 'error', message: err.message });
  });

  proc.on('close', (code) => {
    if (streamProc === proc) streamProc = null;
    if (mainWindow) {
      mainWindow.webContents.send('stream:status', {
        type: code === 0 ? 'ended' : 'error',
        message: code === 0 ? null : `ffmpeg exited with code ${code}\n${stderr.slice(-1000)}`
      });
    }
  });

  return { ok: true };
});

ipcMain.on('stream:chunk', (_e, buf) => {
  if (streamProc && streamProc.stdin.writable) {
    streamProc.stdin.write(Buffer.from(buf));
  }
});

ipcMain.handle('stream:stop', async () => {
  const proc = streamProc;
  streamProc = null;
  if (!proc) return { ok: true };
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: true }); }, 4000);
    proc.once('close', () => { clearTimeout(t); resolve({ ok: true }); });
    try { proc.stdin.end(); } catch { clearTimeout(t); resolve({ ok: true }); }
  });
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

  // Screenshot mode: render the window, optionally switch mode, capture to docs/, exit.
  if (process.env.SHOT) {
    createMainWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const view = process.env.SHOT_VIEW;
          if (view) {
            await mainWindow.webContents.executeJavaScript(
              `(function(){var b=document.querySelector('[data-mode="'+${JSON.stringify(view)}+'"]');if(b)b.click();})();`
            );
            await new Promise((r) => setTimeout(r, 1600));
          }
          const img = await mainWindow.webContents.capturePage();
          const name = view ? 'screenshot-' + view + '.png' : 'screenshot.png';
          const out = path.join(__dirname, 'docs', name);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[shot] wrote ' + out);
        } catch (e) {
          console.error('[shot] failed', e);
        }
        app.exit(0);
      }, 2000);
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

app.on('before-quit', () => {
  if (streamProc) { try { streamProc.kill(); } catch {} streamProc = null; }
});
