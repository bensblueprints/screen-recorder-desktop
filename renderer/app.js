/* BloomRecorder — renderer logic */
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sources = [];
let sourceKind = 'screen';
let selectedSource = null;
let mode = 'screen';               // 'screen' | 'camera' | 'both'

let recorders = [];                // [{ recorder, chunks, label, stream }]
let recordingCtx = null;           // acquired streams / cleanup for the live recording
let previewStream = null;          // live camera preview stream (not recorded)
let stopping = false;

let timerInterval = null;
let recordStartedAt = 0;
let currentItem = null;            // library item open in modal
let exporting = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toast(msg, isError = false, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtTime(secs) {
  secs = Math.max(0, Math.floor(secs));
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#view-' + name).classList.add('active');
  if (name === 'library') renderLibrary();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---------------------------------------------------------------------------
// Source picker (screen / window)
// ---------------------------------------------------------------------------
async function loadSources() {
  const grid = $('#sources-grid');
  try {
    sources = await window.api.listSources();
  } catch (err) {
    grid.innerHTML = '<div class="empty">Failed to list sources: ' + err.message + '</div>';
    return;
  }
  renderSources();
}

function renderSources() {
  const grid = $('#sources-grid');
  const filtered = sources.filter((s) => s.kind === sourceKind);
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty">No ' + sourceKind + 's found.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const s of filtered) {
    const card = document.createElement('div');
    card.className = 'source-card' + (selectedSource && selectedSource.id === s.id ? ' selected' : '');
    const img = document.createElement('img');
    img.src = s.thumbnail;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = s.name;
    card.append(img, label);
    card.addEventListener('click', () => {
      selectedSource = s;
      window.api.selectSource(s.id);
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      updateHint();
      updateRecordButton();
    });
    grid.appendChild(card);
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    sourceKind = tab.dataset.kind;
    renderSources();
  });
});

$('#refresh-sources').addEventListener('click', loadSources);

// ---------------------------------------------------------------------------
// Mode selector
// ---------------------------------------------------------------------------
function needsScreen() { return mode === 'screen' || mode === 'both'; }
function needsCamera() { return mode === 'camera' || mode === 'both'; }
function hasCamera() { const sel = $('#camera-select'); return !!(sel && sel.value); }

function setMode(next) {
  mode = next;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  $('#screen-picker').classList.toggle('hidden', !needsScreen());
  $('#camera-picker').classList.toggle('hidden', !needsCamera());
  $('#split-row').classList.toggle('hidden', mode !== 'both');
  if (needsCamera()) startCameraPreview(); else stopCameraPreview();
  updateHint();
  updateRecordButton();
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

function updateHint() {
  const hint = $('#record-hint');
  const parts = [];
  if (needsScreen()) parts.push(selectedSource ? 'Screen: ' + selectedSource.name : 'Screen: pick a source above');
  if (needsCamera()) parts.push(hasCamera() ? 'Camera: ' + ($('#camera-select').selectedOptions[0]?.textContent || 'selected') : 'Camera: none found');
  if ($('#mic-toggle').checked) parts.push('Mic on');
  if (mode === 'both') parts.push($('#split-toggle').checked ? '→ 2 separate files' : '→ 1 combined file (picture-in-picture)');
  hint.textContent = parts.join('  ·  ');
}

function updateRecordButton() {
  const recording = recorders.some((r) => r.recorder && r.recorder.state === 'recording');
  if (recording) { $('#record-btn').disabled = false; return; }
  let ok = true;
  if (needsScreen() && !selectedSource) ok = false;
  if (needsCamera() && !hasCamera()) ok = false;
  $('#record-btn').disabled = !ok;
}

// ---------------------------------------------------------------------------
// Device enumeration (cameras + microphones)
// ---------------------------------------------------------------------------
async function loadDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { devices = []; }

  // Labels are hidden until permission is granted; unlock once if needed.
  const hasVideo = devices.some((d) => d.kind === 'videoinput');
  const hasAudio = devices.some((d) => d.kind === 'audioinput');
  const labelsHidden = devices.some((d) => (d.kind === 'videoinput' || d.kind === 'audioinput') && !d.label);
  if (labelsHidden && (hasVideo || hasAudio)) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: hasVideo, audio: hasAudio });
      tmp.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* permission denied — fall back to generic labels */ }
  }

  fillDeviceSelect($('#camera-select'), devices.filter((d) => d.kind === 'videoinput'), 'Camera');
  fillDeviceSelect($('#mic-select'), devices.filter((d) => d.kind === 'audioinput'), 'Microphone');
}

function fillDeviceSelect(sel, list, kindName) {
  const prev = sel.value;
  sel.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No ' + kindName.toLowerCase() + ' found';
    sel.appendChild(opt);
    return;
  }
  list.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || (kindName + ' ' + (i + 1));
    sel.appendChild(opt);
  });
  if (prev && list.some((d) => d.deviceId === prev)) sel.value = prev;
}

$('#refresh-cameras').addEventListener('click', async () => { await loadDevices(); if (needsCamera()) startCameraPreview(); updateRecordButton(); updateHint(); });
$('#refresh-mics').addEventListener('click', () => loadDevices());

$('#camera-select').addEventListener('change', () => { if (needsCamera()) startCameraPreview(); updateRecordButton(); updateHint(); });

$('#mic-toggle').addEventListener('change', () => {
  $('#mic-select').disabled = !$('#mic-toggle').checked;
  updateHint();
});
$('#split-toggle').addEventListener('change', updateHint);

// React to devices being plugged/unplugged.
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener?.('devicechange', () => loadDevices());
}

// ---------------------------------------------------------------------------
// Camera preview (live, not recorded)
// ---------------------------------------------------------------------------
async function startCameraPreview() {
  stopCameraPreview();
  const devId = $('#camera-select').value;
  const vid = $('#camera-preview');
  const empty = $('#camera-preview-empty');
  if (!devId) { empty.classList.remove('hidden'); return; }
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: devId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    vid.srcObject = previewStream;
    empty.classList.add('hidden');
  } catch (err) {
    empty.textContent = 'Camera unavailable';
    empty.classList.remove('hidden');
  }
}

function stopCameraPreview() {
  if (previewStream) { previewStream.getTracks().forEach((t) => t.stop()); previewStream = null; }
  const vid = $('#camera-preview');
  if (vid) vid.srcObject = null;
}

// ---------------------------------------------------------------------------
// Output folder
// ---------------------------------------------------------------------------
async function loadOutputDir() {
  try {
    const s = await window.api.getSettings();
    const el = $('#output-dir');
    el.textContent = s.outputDir;
    el.title = s.outputDir;
  } catch { /* ignore */ }
}

$('#choose-output').addEventListener('click', async () => {
  try {
    const dir = await window.api.chooseOutputDir();
    if (dir) {
      $('#output-dir').textContent = dir;
      $('#output-dir').title = dir;
      toast('Recordings will be saved to ' + dir);
    }
  } catch (err) {
    toast('Could not change folder: ' + err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Recording engine
// ---------------------------------------------------------------------------
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
}

// Build a small audio graph so we can hand each recorder its OWN mixed audio
// track (system audio + mic). Each makeTrack() call produces an independent
// track from the same sources, so split files each carry the full audio.
function buildAudioGraph(systemAudioStream, micStream) {
  let ctx = null;
  const nodes = [];
  if (systemAudioStream || micStream) {
    ctx = new AudioContext();
    if (systemAudioStream && systemAudioStream.getAudioTracks().length) {
      nodes.push(ctx.createMediaStreamSource(systemAudioStream));
    }
    if (micStream && micStream.getAudioTracks().length) {
      nodes.push(ctx.createMediaStreamSource(micStream));
    }
  }
  return {
    ctx,
    makeTrack() {
      if (!ctx || !nodes.length) return null;
      const dest = ctx.createMediaStreamDestination();
      for (const n of nodes) n.connect(dest);
      return dest.stream.getAudioTracks()[0];
    }
  };
}

function makeRecorder(videoTrack, audioTrack, label) {
  const tracks = [videoTrack];
  if (audioTrack) tracks.push(audioTrack);
  const stream = new MediaStream(tracks);
  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 8_000_000
  });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorders.push({ recorder, chunks, label, stream });
  return recorder;
}

// Composite screen + camera into one canvas stream (picture-in-picture).
async function makeCompositeStream(screenTrack, camTrack) {
  const mkVideo = (track) => new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true;
    v.srcObject = new MediaStream([track]);
    v.onloadedmetadata = () => { v.play().then(() => resolve(v)).catch(() => resolve(v)); };
  });
  const [sv, cv] = await Promise.all([mkVideo(screenTrack), mkVideo(camTrack)]);
  const w = sv.videoWidth || 1920;
  const h = sv.videoHeight || 1080;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  let raf = 0, live = true;

  const draw = () => {
    if (!live) return;
    try {
      ctx.drawImage(sv, 0, 0, w, h);
      const pw = Math.round(w * 0.22);
      const ar = (cv.videoWidth || 16) / (cv.videoHeight || 9);
      const ph = Math.round(pw / ar);
      const m = Math.round(w * 0.02);
      const x = w - pw - m;
      const y = h - ph - m;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.round(w * 0.012);
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 3, y - 3, pw + 6, ph + 6);
      ctx.shadowBlur = 0;
      ctx.drawImage(cv, x, y, pw, ph);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, pw, ph);
      ctx.restore();
    } catch { /* frame not ready yet */ }
    raf = requestAnimationFrame(draw);
  };
  draw();

  const stream = canvas.captureStream(30);
  return {
    stream,
    cleanup() { live = false; cancelAnimationFrame(raf); sv.srcObject = null; cv.srcObject = null; }
  };
}

async function startRecording() {
  const withMic = $('#mic-toggle').checked;
  const split = $('#split-toggle').checked;

  if (needsScreen() && !selectedSource) { toast('Pick a screen or window first', true); return; }
  if (needsCamera() && !hasCamera()) { toast('No camera available', true); return; }

  // Free the preview camera so the recording can open the device cleanly.
  stopCameraPreview();

  recorders = [];
  const cleanup = [];
  let display = null, camStream = null, micStream = null, audioCtx = null;

  try {
    let screenTrack = null, systemAudioStream = null, camTrack = null;

    if (needsScreen()) {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenTrack = display.getVideoTracks()[0];
      if (display.getAudioTracks().length) systemAudioStream = new MediaStream([display.getAudioTracks()[0]]);
    }

    if (needsCamera()) {
      const devId = $('#camera-select').value;
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: devId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      camTrack = camStream.getVideoTracks()[0];
    }

    if (withMic) {
      const micId = $('#mic-select').value;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true
          }
        });
      } catch (err) {
        toast('Mic unavailable, recording without it (' + err.message + ')', true);
      }
    }

    const audio = buildAudioGraph(systemAudioStream, micStream);
    audioCtx = audio.ctx;

    if (mode === 'screen') {
      makeRecorder(screenTrack, audio.makeTrack(), null);
    } else if (mode === 'camera') {
      makeRecorder(camTrack, audio.makeTrack(), null);
    } else { // both
      if (split) {
        makeRecorder(screenTrack, audio.makeTrack(), 'screen');
        makeRecorder(camTrack, audio.makeTrack(), 'camera');
      } else {
        const comp = await makeCompositeStream(screenTrack, camTrack);
        cleanup.push(comp.cleanup);
        makeRecorder(comp.stream.getVideoTracks()[0], audio.makeTrack(), null);
      }
    }

    if (!recorders.length) throw new Error('Nothing to record');

    recordingCtx = { display, camStream, micStream, audioCtx, cleanup };

    // Stop cleanly if the user ends screen sharing from the OS layer.
    if (screenTrack) screenTrack.addEventListener('ended', () => stopRecording());

    stopping = false;
    for (const r of recorders) r.recorder.start(1000);
    recordStartedAt = Date.now();

    // UI
    const btn = $('#record-btn');
    btn.classList.add('recording');
    $('#record-btn-label').textContent = 'Stop recording';
    $('#rec-timer').classList.remove('hidden');
    timerInterval = setInterval(() => {
      $('#rec-timer-text').textContent = fmtTime((Date.now() - recordStartedAt) / 1000);
    }, 250);

    window.api.recordingStarted(); // spawns floating stop indicator
    if ($('#minimize-toggle').checked) window.api.minimizeWindow();
  } catch (err) {
    toast('Could not start recording: ' + err.message, true);
    [display, camStream, micStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
    if (audioCtx) audioCtx.close().catch(() => {});
    for (const c of cleanup) c();
    recorders = [];
    recordingCtx = null;
    if (needsCamera()) startCameraPreview();
  }
}

function stopRecording() {
  if (stopping) return;
  stopping = true;
  const active = recorders.filter((r) => r.recorder.state !== 'inactive');
  if (!active.length) { finalizeRecording(); return; }
  let remaining = active.length;
  for (const r of active) {
    r.recorder.onstop = () => { if (--remaining === 0) finalizeRecording(); };
    r.recorder.stop();
  }
}

async function finalizeRecording() {
  clearInterval(timerInterval);
  window.api.recordingStopped();

  const ctx = recordingCtx || {};
  [ctx.display, ctx.camStream, ctx.micStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  for (const r of recorders) r.stream.getTracks().forEach((t) => t.stop());
  for (const c of (ctx.cleanup || [])) { try { c(); } catch {} }
  if (ctx.audioCtx) ctx.audioCtx.close().catch(() => {});

  const btn = $('#record-btn');
  btn.classList.remove('recording');
  $('#record-btn-label').textContent = 'Start recording';
  $('#rec-timer').classList.add('hidden');

  const toSave = recorders.filter((r) => r.chunks.length);
  recorders = [];
  recordingCtx = null;
  updateRecordButton();

  if (!toSave.length) {
    toast('Nothing was recorded.', true);
    if (needsCamera()) startCameraPreview();
    return;
  }

  const savedNames = [];
  for (const r of toSave) {
    const blob = new Blob(r.chunks, { type: 'video/webm' });
    try {
      const buf = await blob.arrayBuffer();
      const file = await window.api.saveRecording(buf, r.label || null);
      savedNames.push(file.split(/[\\/]/).pop());
    } catch (err) {
      toast('Failed to save ' + (r.label || 'recording') + ': ' + err.message, true);
    }
  }

  if (savedNames.length) {
    toast('Saved: ' + savedNames.join(', '));
    switchView('library');
  }
  if (needsCamera()) startCameraPreview();
}

$('#record-btn').addEventListener('click', () => {
  const recording = recorders.some((r) => r.recorder && r.recorder.state === 'recording');
  if (recording) stopRecording();
  else startRecording();
});

window.api.onStopRequested(() => stopRecording());

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
async function renderLibrary() {
  const grid = $('#library-grid');
  let items;
  try {
    items = await window.api.listLibrary();
  } catch (err) {
    grid.innerHTML = '<div class="empty">Failed to read library: ' + err.message + '</div>';
    return;
  }
  if (!items.length) {
    grid.innerHTML = '<div class="empty">No recordings yet — make your first one!</div>';
    return;
  }
  grid.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'lib-card';
    let thumb;
    if (item.thumbnail) {
      thumb = document.createElement('img');
      thumb.className = 'lib-thumb';
      thumb.src = item.thumbnail;
    } else {
      thumb = document.createElement('div');
      thumb.className = 'lib-thumb placeholder';
      thumb.textContent = '🎬';
    }
    const info = document.createElement('div');
    info.className = 'lib-info';
    const name = document.createElement('div');
    name.className = 'lib-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const badge = document.createElement('span');
    badge.className = 'lib-badge';
    badge.textContent = item.ext;
    meta.append(badge, fmtSize(item.size), new Date(item.mtime).toLocaleString());
    info.append(name, meta);
    card.append(thumb, info);
    card.addEventListener('click', () => openModal(item));
    grid.appendChild(card);
  }
}

$('#open-folder').addEventListener('click', () => window.api.openFolder());

// ---------------------------------------------------------------------------
// Modal: player + trim + export
// ---------------------------------------------------------------------------
async function openModal(item) {
  currentItem = item;
  $('#modal-title').textContent = item.name;
  const player = $('#player');
  player.src = item.url;
  $('#trim-start').value = 0;
  $('#trim-end').value = '';
  $('#trim-meta').textContent = '';
  $('#export-progress').classList.add('hidden');
  $('#modal').classList.remove('hidden');

  const canExport = item.ext !== 'gif';
  $('#export-mp4').disabled = !canExport || exporting;
  $('#export-gif').disabled = !canExport || exporting;

  // WebM from MediaRecorder often reports Infinity duration; ask ffmpeg.
  let dur = null;
  try { dur = await window.api.getDuration(item.path); } catch {}
  if (dur) {
    $('#trim-end').value = dur.toFixed(1);
    $('#trim-meta').textContent = 'Duration: ' + dur.toFixed(1) + 's';
  }
}

function closeModal() {
  const player = $('#player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('#modal').classList.add('hidden');
  currentItem = null;
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

$('#reveal-file').addEventListener('click', () => currentItem && window.api.reveal(currentItem.path));

$('#delete-file').addEventListener('click', async () => {
  if (!currentItem) return;
  try {
    await window.api.deleteRecording(currentItem.path);
    toast('Deleted ' + currentItem.name);
    closeModal();
    renderLibrary();
  } catch (err) {
    toast('Delete failed: ' + err.message, true);
  }
});

async function runExport(format) {
  if (!currentItem || exporting) return;
  exporting = true;
  const progWrap = $('#export-progress');
  const fill = $('#progress-fill');
  const label = $('#progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '0%';
  label.textContent = 'Exporting ' + format.toUpperCase() + '… 0%';
  $('#export-mp4').disabled = true;
  $('#export-gif').disabled = true;

  try {
    const res = await window.api.exportRun({
      input: currentItem.path,
      format,
      trimStart: parseFloat($('#trim-start').value) || 0,
      trimEnd: $('#trim-end').value === '' ? null : parseFloat($('#trim-end').value)
    });
    fill.style.width = '100%';
    label.textContent = 'Done → ' + res.output.split(/[\\/]/).pop() + ' (' + fmtSize(res.size) + ')';
    toast(format.toUpperCase() + ' exported');
    renderLibrary();
  } catch (err) {
    label.textContent = 'Export failed';
    toast('Export failed: ' + err.message, true, 6000);
  } finally {
    exporting = false;
    if (currentItem) {
      const canExport = currentItem.ext !== 'gif';
      $('#export-mp4').disabled = !canExport;
      $('#export-gif').disabled = !canExport;
    }
  }
}

window.api.onExportProgress(({ percent }) => {
  if (!exporting) return;
  $('#progress-fill').style.width = percent + '%';
  $('#progress-label').textContent = 'Exporting… ' + percent + '%';
});

$('#export-mp4').addEventListener('click', () => runExport('mp4'));
$('#export-gif').addEventListener('click', () => runExport('gif'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadSources();
loadDevices().then(() => { updateRecordButton(); updateHint(); });
loadOutputDir();
renderLibrary();
