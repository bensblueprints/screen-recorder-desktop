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
let isPaused = false;
let totalPausedMs = 0;
let pauseStartedAt = 0;
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
  fillDeviceSelect($('#live-camera-select'), devices.filter((d) => d.kind === 'videoinput'), 'Camera');
  fillDeviceSelect($('#live-mic-select'), devices.filter((d) => d.kind === 'audioinput'), 'Microphone');
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
// getPos(), if provided, returns { xPct, yPct, wPct } (0-1 fractions of the
// canvas) for the camera box each frame; defaults to a fixed bottom-right PiP.
async function makeCompositeStream(screenTrack, camTrack, getPos) {
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

  const defaultPos = () => ({ xPct: null, yPct: null, wPct: 0.22 });

  const draw = () => {
    if (!live) return;
    try {
      ctx.drawImage(sv, 0, 0, w, h);
      const pos = (getPos ? getPos() : null) || defaultPos();
      const pw = Math.round(w * (pos.wPct || 0.22));
      const ar = (cv.videoWidth || 16) / (cv.videoHeight || 9);
      const ph = Math.round(pw / ar);
      const m = Math.round(w * 0.02);
      const x = pos.xPct == null ? (w - pw - m) : Math.round(pos.xPct * w);
      const y = pos.yPct == null ? (h - ph - m) : Math.round(pos.yPct * h);
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
    isPaused = false;
    totalPausedMs = 0;
    pauseStartedAt = 0;

    // UI
    const btn = $('#record-btn');
    btn.classList.add('recording');
    $('#record-btn-label').textContent = 'Stop recording';
    $('#rec-timer').classList.remove('hidden');
    timerInterval = setInterval(() => {
      const now = isPaused ? pauseStartedAt : Date.now();
      $('#rec-timer-text').textContent = fmtTime((now - recordStartedAt - totalPausedMs) / 1000);
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

  const sharedStamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const savedNames = [];
  for (const r of toSave) {
    const blob = new Blob(r.chunks, { type: 'video/webm' });
    try {
      const buf = await blob.arrayBuffer();
      const file = await window.api.saveRecording(buf, r.label || null, sharedStamp);
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
  const recording = recorders.some((r) => r.recorder && (r.recorder.state === 'recording' || r.recorder.state === 'paused'));
  if (recording) stopRecording();
  else startRecording();
});

function togglePauseRecording() {
  const active = recorders.filter((r) => r.recorder.state !== 'inactive');
  if (!active.length) return;
  if (!isPaused) {
    active.forEach((r) => { if (r.recorder.state === 'recording') r.recorder.pause(); });
    isPaused = true;
    pauseStartedAt = Date.now();
  } else {
    active.forEach((r) => { if (r.recorder.state === 'paused') r.recorder.resume(); });
    totalPausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = 0;
    isPaused = false;
  }
  window.api.setOverlayPaused(isPaused);
}

window.api.onStopRequested(() => stopRecording());
window.api.onPauseToggleRequested(() => togglePauseRecording());

// ---------------------------------------------------------------------------
// Go Live (RTMP streaming)
// ---------------------------------------------------------------------------
let liveSources = [];
let liveSourceKind = 'screen';
let liveSelectedSource = null;
let livePreviewDisplay = null;   // persistent screen preview stream, reused when going live
let liveCamPreviewStream = null; // persistent camera preview stream, reused when going live

let liveCamPos = { xPct: 0.75, yPct: 0.72, wPct: 0.22 }; // fractions of the canvas
let dragState = null; // { mode: 'move'|'resize', startX, startY, startPos }

let liveActive = false;
let liveRecorder = null;
let liveChunks = [];
let liveCleanup = [];
let liveCtx = null; // { micStream, audioCtx }
let liveTimerInterval = null;
let liveStartedAt = 0;

async function loadLiveSources() {
  const grid = $('#live-sources-grid');
  try {
    liveSources = await window.api.listSources();
  } catch (err) {
    grid.innerHTML = '<div class="empty">Failed to list sources: ' + err.message + '</div>';
    return;
  }
  renderLiveSources();
}

function renderLiveSources() {
  const grid = $('#live-sources-grid');
  const filtered = liveSources.filter((s) => s.kind === liveSourceKind);
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty">No ' + liveSourceKind + 's found.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const s of filtered) {
    const card = document.createElement('div');
    card.className = 'source-card' + (liveSelectedSource && liveSelectedSource.id === s.id ? ' selected' : '');
    const img = document.createElement('img');
    img.src = s.thumbnail;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = s.name;
    card.append(img, label);
    card.addEventListener('click', async () => {
      liveSelectedSource = s;
      window.api.selectSource(s.id);
      document.querySelectorAll('#live-sources-grid .source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      updateLiveButton();
      await startLivePreviewScreen();
    });
    grid.appendChild(card);
  }
}

document.querySelectorAll('[data-live-kind]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-live-kind]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    liveSourceKind = tab.dataset.liveKind;
    renderLiveSources();
  });
});

$('#refresh-live-sources').addEventListener('click', loadLiveSources);

async function startLivePreviewScreen() {
  if (livePreviewDisplay) { livePreviewDisplay.getTracks().forEach((t) => t.stop()); livePreviewDisplay = null; }
  try {
    livePreviewDisplay = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    $('#live-preview-video').srcObject = livePreviewDisplay;
    $('#live-preview-empty').classList.add('hidden');
    $('#live-cam-box').classList.remove('hidden');
    positionCamBox();
    livePreviewDisplay.getVideoTracks()[0].addEventListener('ended', () => {
      if (liveActive) stopLive();
      livePreviewDisplay = null;
      $('#live-preview-video').srcObject = null;
      $('#live-preview-empty').textContent = 'Pick a screen source above to preview placement';
      $('#live-preview-empty').classList.remove('hidden');
      $('#live-cam-box').classList.add('hidden');
    });
  } catch (err) {
    $('#live-preview-empty').textContent = 'Preview unavailable: ' + err.message;
    $('#live-preview-empty').classList.remove('hidden');
  }
  updateLiveButton();
}

async function startLiveCameraPreview() {
  if (liveCamPreviewStream) { liveCamPreviewStream.getTracks().forEach((t) => t.stop()); liveCamPreviewStream = null; }
  const devId = $('#live-camera-select').value;
  if (!devId) { updateLiveButton(); return; }
  try {
    liveCamPreviewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: devId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    $('#live-cam-box-video').srcObject = liveCamPreviewStream;
  } catch { /* camera unavailable — Go Live stays disabled */ }
  updateLiveButton();
}

$('#live-camera-select').addEventListener('change', startLiveCameraPreview);

// ---- Camera box drag/resize (positions expressed as fractions of the preview) ----
function positionCamBox() {
  const wrap = $('#live-preview-wrap');
  const box = $('#live-cam-box');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const bw = Math.round(w * liveCamPos.wPct);
  const bh = Math.round(bw * 9 / 16);
  box.style.width = bw + 'px';
  box.style.height = bh + 'px';
  box.style.left = Math.round(liveCamPos.xPct * w) + 'px';
  box.style.top = Math.round(liveCamPos.yPct * h) + 'px';
}

$('#live-cam-box').addEventListener('pointerdown', (e) => {
  if (e.target === $('#live-cam-resize')) return;
  const wrap = $('#live-preview-wrap');
  dragState = { mode: 'move', startX: e.clientX, startY: e.clientY, startPos: { ...liveCamPos }, w: wrap.clientWidth, h: wrap.clientHeight };
  e.preventDefault();
});
$('#live-cam-resize').addEventListener('pointerdown', (e) => {
  const wrap = $('#live-preview-wrap');
  dragState = { mode: 'resize', startX: e.clientX, startY: e.clientY, startPos: { ...liveCamPos }, w: wrap.clientWidth, h: wrap.clientHeight };
  e.stopPropagation();
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = (e.clientX - dragState.startX) / dragState.w;
  const dy = (e.clientY - dragState.startY) / dragState.h;
  if (dragState.mode === 'move') {
    liveCamPos.xPct = Math.min(1 - liveCamPos.wPct, Math.max(0, dragState.startPos.xPct + dx));
    const bh = liveCamPos.wPct * (9 / 16);
    liveCamPos.yPct = Math.min(1 - bh, Math.max(0, dragState.startPos.yPct + dy));
  } else {
    liveCamPos.wPct = Math.min(0.6, Math.max(0.1, dragState.startPos.wPct + dx));
  }
  positionCamBox();
});
window.addEventListener('pointerup', () => { dragState = null; });
window.addEventListener('resize', () => { if (!$('#live-cam-box').classList.contains('hidden')) positionCamBox(); });

// ---- Service tabs (Twitch / Custom RTMP) ----
document.querySelectorAll('.mode-btn[data-service]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn[data-service]').forEach((b) => b.classList.toggle('active', b === btn));
    const svc = btn.dataset.service;
    $('#service-twitch').classList.toggle('hidden', svc !== 'twitch');
    $('#service-custom').classList.toggle('hidden', svc !== 'custom');
    updateLiveButton();
  });
});

$('#twitch-connect').addEventListener('click', () => {
  window.api.openExternal('https://dashboard.twitch.tv/settings/stream');
});

$('#twitch-key').addEventListener('input', updateLiveButton);
$('#custom-url').addEventListener('input', updateLiveButton);
$('#custom-key').addEventListener('input', updateLiveButton);

function activeService() {
  return document.querySelector('.mode-btn[data-service].active')?.dataset.service || 'twitch';
}

function buildStreamTarget() {
  if (activeService() === 'twitch') {
    const key = $('#twitch-key').value.trim();
    return key ? 'rtmp://live.twitch.tv/app/' + key : null;
  }
  const url = $('#custom-url').value.trim();
  const key = $('#custom-key').value.trim();
  if (!url) return null;
  return url.replace(/\/+$/, '') + (key ? '/' + key : '');
}

function updateLiveButton() {
  if (liveActive) { $('#live-btn').disabled = false; return; }
  const ok = !!livePreviewDisplay && !!liveCamPreviewStream && !!buildStreamTarget();
  $('#live-btn').disabled = !ok;
}

async function startLive() {
  const target = buildStreamTarget();
  if (!livePreviewDisplay) { toast('Pick a screen source first', true); return; }
  if (!liveCamPreviewStream) { toast('Pick a camera first', true); return; }
  if (!target) { toast('Enter your stream key / RTMP details first', true); return; }

  let micStream = null, audioCtx = null;
  const pos = { ...liveCamPos };

  try {
    const screenTrack = livePreviewDisplay.getVideoTracks()[0];
    const camTrack = liveCamPreviewStream.getVideoTracks()[0];
    const systemAudioStream = livePreviewDisplay.getAudioTracks().length
      ? new MediaStream([livePreviewDisplay.getAudioTracks()[0]]) : null;

    if ($('#live-mic-toggle').checked) {
      const micId = $('#live-mic-select').value;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true }
        });
      } catch (err) {
        toast('Mic unavailable, going live without it (' + err.message + ')', true);
      }
    }

    const audio = buildAudioGraph(systemAudioStream, micStream);
    audioCtx = audio.ctx;

    const comp = await makeCompositeStream(screenTrack, camTrack, () => pos);
    liveCleanup = [comp.cleanup];

    await window.api.streamStart({ target });

    const outStream = new MediaStream([comp.stream.getVideoTracks()[0]]);
    const audioTrack = audio.makeTrack();
    if (audioTrack) outStream.addTrack(audioTrack);

    liveChunks = [];
    liveRecorder = new MediaRecorder(outStream, { mimeType: pickMimeType(), videoBitsPerSecond: 6_000_000 });
    liveRecorder.ondataavailable = async (e) => {
      if (!e.data.size) return;
      liveChunks.push(e.data);
      try {
        const buf = await e.data.arrayBuffer();
        window.api.streamChunk(buf);
      } catch { /* ignore a dropped chunk */ }
    };
    liveRecorder.start(500);

    liveCtx = { micStream, audioCtx };
    liveActive = true;
    liveStartedAt = Date.now();
    updateLiveUI(true);
  } catch (err) {
    toast('Could not go live: ' + err.message, true);
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    for (const c of liveCleanup) c();
    liveCleanup = [];
    try { await window.api.streamStop(); } catch {}
  }
}

function stopLive() {
  if (!liveActive) return;
  liveActive = false;
  if (liveRecorder && liveRecorder.state !== 'inactive') {
    liveRecorder.onstop = finalizeLive;
    liveRecorder.stop();
  } else {
    finalizeLive();
  }
}

async function finalizeLive() {
  await window.api.streamStop();

  const ctx = liveCtx || {};
  if (ctx.micStream) ctx.micStream.getTracks().forEach((t) => t.stop());
  for (const c of liveCleanup) { try { c(); } catch {} }
  liveCleanup = [];
  if (ctx.audioCtx) ctx.audioCtx.close().catch(() => {});
  liveCtx = null;
  liveRecorder = null;

  updateLiveUI(false);

  const chunks = liveChunks;
  liveChunks = [];
  if (chunks.length) {
    const blob = new Blob(chunks, { type: 'video/webm' });
    try {
      const buf = await blob.arrayBuffer();
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const file = await window.api.saveRecording(buf, 'live', stamp);
      toast('Stream ended. Saved: ' + file.split(/[\\/]/).pop());
    } catch (err) {
      toast('Stream ended, but saving the local copy failed: ' + err.message, true);
    }
  } else {
    toast('Stream ended.');
  }
}

function updateLiveUI(active) {
  const btn = $('#live-btn');
  btn.classList.toggle('recording', active);
  $('#live-btn-label').textContent = active ? 'End stream' : 'Go live';
  $('#live-timer').classList.toggle('hidden', !active);
  clearInterval(liveTimerInterval);
  if (active) {
    liveTimerInterval = setInterval(() => {
      $('#live-timer-text').textContent = fmtTime((Date.now() - liveStartedAt) / 1000);
    }, 250);
  }
  updateLiveButton();
}

$('#live-btn').addEventListener('click', () => {
  if (liveActive) stopLive(); else startLive();
});

window.api.onStreamStatus(({ type, message }) => {
  if (type === 'error') {
    toast('Stream error: ' + (message || 'connection failed'), true, 6000);
    if (liveActive) stopLive();
  }
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
let libItems = [];
let libSort = 'date-desc';
let libFilters = new Set(); // subset of 'captioned' | 'reel'

async function renderLibrary() {
  const grid = $('#library-grid');
  try {
    libItems = await window.api.listLibrary();
  } catch (err) {
    grid.innerHTML = '<div class="empty">Failed to read library: ' + err.message + '</div>';
    return;
  }
  if (!libItems.length) {
    grid.innerHTML = '<div class="empty">No recordings yet — make your first one!</div>';
    return;
  }

  let items = libItems.slice();
  if (libFilters.has('captioned')) items = items.filter((i) => i.captioned);
  if (libFilters.has('reel')) items = items.filter((i) => i.isReel);

  items.sort((a, b) => {
    if (libSort === 'date-asc') return a.mtime - b.mtime;
    if (libSort === 'name') return a.name.localeCompare(b.name);
    if (libSort === 'size') return b.size - a.size;
    return b.mtime - a.mtime; // date-desc
  });

  if (!items.length) {
    grid.innerHTML = '<div class="empty">No recordings match this filter.</div>';
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
    meta.append(badge);
    if (item.captioned) {
      const cb = document.createElement('span');
      cb.className = 'lib-badge captioned';
      cb.textContent = 'CC';
      meta.append(cb);
    }
    if (item.isReel) {
      const rb = document.createElement('span');
      rb.className = 'lib-badge reel';
      rb.textContent = 'Reel';
      meta.append(rb);
    }
    meta.append(fmtSize(item.size), new Date(item.mtime).toLocaleString());
    info.append(name, meta);
    card.append(thumb, info);
    card.dataset.path = item.path;

    if (selectMode) {
      card.classList.add('selectable');
      if (selectedItems.has(item.path)) card.classList.add('selected');
      const badge = document.createElement('div');
      badge.className = 'lib-select-badge';
      badge.textContent = selectedItems.has(item.path) ? '✓' : '';
      card.appendChild(badge);
      card.addEventListener('click', (e) => { e.stopPropagation(); toggleCardSelection(item.path, card); });
    } else {
      card.addEventListener('click', () => openModal(item));
    }
    grid.appendChild(card);
  }
}

$('#lib-sort').addEventListener('change', () => { libSort = $('#lib-sort').value; renderLibrary(); });
document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const f = chip.dataset.filter;
    if (libFilters.has(f)) libFilters.delete(f); else libFilters.add(f);
    chip.classList.toggle('active', libFilters.has(f));
    renderLibrary();
  });
});

// ---------------------------------------------------------------------------
// Library multi-select — click-to-toggle + drag rubber-band — and batch delete
// ---------------------------------------------------------------------------
let selectMode = false;
let selectedItems = new Set(); // paths
let rubberBandState = null;

function toggleCardSelection(itemPath, cardEl) {
  const badge = cardEl.querySelector('.lib-select-badge');
  if (selectedItems.has(itemPath)) {
    selectedItems.delete(itemPath);
    cardEl.classList.remove('selected');
    if (badge) badge.textContent = '';
  } else {
    selectedItems.add(itemPath);
    cardEl.classList.add('selected');
    if (badge) badge.textContent = '✓';
  }
  updateBatchToolbar();
}

function updateBatchToolbar() {
  const n = selectedItems.size;
  $('#batch-count').textContent = n + ' selected';
  $('#batch-delete').disabled = n === 0;
}

$('#toggle-select-mode').addEventListener('click', () => {
  selectMode = !selectMode;
  $('#toggle-select-mode').classList.toggle('active', selectMode);
  $('#toggle-select-mode').textContent = selectMode ? 'Done' : 'Select';
  $('#batch-toolbar').classList.toggle('hidden', !selectMode);
  if (!selectMode) selectedItems.clear();
  updateBatchToolbar();
  renderLibrary();
});

$('#batch-select-all').addEventListener('click', () => {
  document.querySelectorAll('#library-grid .lib-card').forEach((card) => {
    selectedItems.add(card.dataset.path);
    card.classList.add('selected');
    const badge = card.querySelector('.lib-select-badge');
    if (badge) badge.textContent = '✓';
  });
  updateBatchToolbar();
});

$('#batch-clear').addEventListener('click', () => {
  selectedItems.clear();
  document.querySelectorAll('#library-grid .lib-card.selected').forEach((card) => {
    card.classList.remove('selected');
    const badge = card.querySelector('.lib-select-badge');
    if (badge) badge.textContent = '';
  });
  updateBatchToolbar();
});

$('#batch-delete').addEventListener('click', async () => {
  const paths = [...selectedItems];
  if (!paths.length) return;
  if (!window.confirm(`Delete ${paths.length} selected recording${paths.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  $('#batch-delete').disabled = true;
  let failed = 0;
  for (const p of paths) {
    try { await window.api.deleteRecording(p); } catch { failed++; }
  }
  selectedItems.clear();
  toast(failed ? `Deleted ${paths.length - failed}, ${failed} failed` : `Deleted ${paths.length} recording${paths.length === 1 ? '' : 's'}`, !!failed);
  updateBatchToolbar();
  renderLibrary();
});

// Drag rubber-band select — only active in select mode, and only when the
// drag starts on empty grid space (not on a card, which handles its own click).
$('#library-grid').addEventListener('mousedown', (e) => {
  if (!selectMode || e.target.closest('.lib-card')) return;
  const box = document.createElement('div');
  box.className = 'selection-box';
  document.body.appendChild(box);
  rubberBandState = { startX: e.clientX, startY: e.clientY, box };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!rubberBandState) return;
  const { startX, startY, box } = rubberBandState;
  const x1 = Math.min(startX, e.clientX), x2 = Math.max(startX, e.clientX);
  const y1 = Math.min(startY, e.clientY), y2 = Math.max(startY, e.clientY);
  box.style.left = x1 + 'px';
  box.style.top = y1 + 'px';
  box.style.width = (x2 - x1) + 'px';
  box.style.height = (y2 - y1) + 'px';

  document.querySelectorAll('#library-grid .lib-card').forEach((card) => {
    const r = card.getBoundingClientRect();
    const intersects = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
    card.classList.toggle('drag-hit', intersects);
  });
});

window.addEventListener('mouseup', () => {
  if (!rubberBandState) return;
  document.querySelectorAll('#library-grid .lib-card.drag-hit').forEach((card) => {
    card.classList.remove('drag-hit');
    if (!selectedItems.has(card.dataset.path)) {
      selectedItems.add(card.dataset.path);
      card.classList.add('selected');
      const badge = card.querySelector('.lib-select-badge');
      if (badge) badge.textContent = '✓';
    }
  });
  rubberBandState.box.remove();
  rubberBandState = null;
  updateBatchToolbar();
});

$('#open-folder').addEventListener('click', () => window.api.openFolder());

$('#suite-ad-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://onetimesuite.com');
});

// ---------------------------------------------------------------------------
// Modal: player + trim + export
// ---------------------------------------------------------------------------
let currentPair = null;
let buildingShort = false;
let capturingCaptions = false;
let makingReels = false;

async function openModal(item) {
  currentItem = item;
  currentPair = null;
  const dotIdx = item.name.lastIndexOf('.');
  $('#modal-title-input').value = dotIdx > -1 ? item.name.slice(0, dotIdx) : item.name;
  $('#modal-ext').textContent = '.' + item.ext;
  const player = $('#player');
  player.src = item.url;
  $('#trim-start').value = 0;
  $('#trim-end').value = '';
  $('#trim-meta').textContent = '';
  $('#export-progress').classList.add('hidden');
  $('#short-block').classList.add('hidden');
  $('#short-progress').classList.add('hidden');
  $('#captions-progress').classList.add('hidden');
  $('#captions-replace').checked = false;
  $('#reels-progress').classList.add('hidden');
  $('#modal').classList.remove('hidden');

  const canExport = item.ext !== 'gif';
  $('#export-mp4').disabled = !canExport || exporting;
  $('#export-gif').disabled = !canExport || exporting;

  const canTranscribe = item.ext !== 'gif';
  $('#captions-block').classList.toggle('hidden', !canTranscribe);
  $('#add-captions').disabled = !canTranscribe || capturingCaptions;
  $('#reels-block').classList.toggle('hidden', !canTranscribe);
  $('#make-reels').disabled = !canTranscribe || makingReels;
  $('#silence-entry-block').classList.toggle('hidden', !canTranscribe);
  $('#open-silence-editor').disabled = !canTranscribe;
  $('#transcript-entry-block').classList.toggle('hidden', !canTranscribe);
  $('#open-transcript-editor').disabled = !canTranscribe;
  $('#captions-preview').classList.toggle('hidden', !canTranscribe);
  captionsPos = { ...CAPTION_PRESETS.bottom };
  document.querySelectorAll('.chip[data-caption-preset]').forEach((c) => c.classList.toggle('active', c.dataset.captionPreset === 'bottom'));
  if (canTranscribe) updateCaptionsPreview();

  // WebM from MediaRecorder often reports Infinity duration; ask ffmpeg.
  let dur = null;
  try { dur = await window.api.getDuration(item.path); } catch {}
  if (dur) {
    $('#trim-end').value = dur.toFixed(1);
    $('#trim-meta').textContent = 'Duration: ' + dur.toFixed(1) + 's';
  }

  if (item.ext === 'webm') {
    try { currentPair = await window.api.findPair(item.path); } catch { currentPair = null; }
  }
  const hasPair = !!currentPair;
  $('#short-block').classList.toggle('hidden', !canExport);
  $('#build-short').disabled = !canExport || buildingShort;
  $('#short-combine').checked = hasPair;
  $('#short-combine').disabled = !hasPair;
  $('#short-combine-hint').textContent = hasPair
    ? '(screen + camera pair found)'
    : '(no paired recording — will crop just this video to 9:16)';
  $('#short-cam-top-row').classList.toggle('hidden', !(hasPair && $('#short-combine').checked));
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

$('#rename-file').addEventListener('click', async () => {
  if (!currentItem) return;
  const newBase = $('#modal-title-input').value.trim();
  if (!newBase) { toast('Enter a name', true); return; }
  try {
    const newPath = await window.api.renameRecording(currentItem.path, newBase);
    toast('Renamed to ' + newPath.split(/[\\/]/).pop());
    closeModal();
    renderLibrary();
  } catch (err) {
    toast('Rename failed: ' + err.message, true);
  }
});
$('#modal-title-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#rename-file').click();
});

$('#delete-file').addEventListener('click', async () => {
  if (!currentItem) return;
  const target = currentItem;
  // Release the player's hold on the file before asking the OS to delete it —
  // otherwise an actively-open <video> can transiently lock it on Windows.
  const player = $('#player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  try {
    await window.api.deleteRecording(target.path);
    toast('Deleted ' + target.name);
    closeModal();
    renderLibrary();
  } catch (err) {
    toast('Delete failed: ' + err.message, true, 6000);
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

$('#short-combine').addEventListener('change', () => {
  $('#short-cam-top-row').classList.toggle('hidden', !($('#short-combine').checked && currentPair));
});

$('#build-short').addEventListener('click', async () => {
  if (!currentItem || buildingShort) return;
  const combine = $('#short-combine').checked && !!currentPair;
  buildingShort = true;
  const progWrap = $('#short-progress');
  const fill = $('#short-progress-fill');
  const label = $('#short-progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '0%';
  label.textContent = 'Building… 0%';
  $('#build-short').disabled = true;

  try {
    const fitFullScreen = $('#short-fit-full').checked;
    const res = await window.api.buildShort(combine ? {
      combine: true,
      screenPath: currentPair.screenPath,
      cameraPath: currentPair.cameraPath,
      cameraOnTop: $('#short-cam-top').checked,
      fitFullScreen
    } : {
      combine: false,
      input: currentItem.path,
      fitFullScreen
    });
    fill.style.width = '100%';
    label.textContent = 'Done → ' + res.output.split(/[\\/]/).pop() + ' (' + fmtSize(res.size) + ')';
    toast('Short built');
    renderLibrary();
  } catch (err) {
    label.textContent = 'Build failed';
    toast('Build Short failed: ' + err.message, true, 6000);
  } finally {
    buildingShort = false;
    $('#build-short').disabled = false;
  }
});

window.api.onShortsProgress(({ percent }) => {
  if (!buildingShort) return;
  $('#short-progress-fill').style.width = percent + '%';
  $('#short-progress-label').textContent = 'Building… ' + percent + '%';
});

// ---------------------------------------------------------------------------
// Captions (local transcription + burn-in)
// ---------------------------------------------------------------------------
function describeProgress(p) {
  if (!p) return '';
  if (p.phase === 'decoding-audio') return 'Decoding audio…';
  if (p.phase === 'downloading-model') return `Downloading speech model (${p.file || ''} ${p.percent || 0}%)…`;
  if (p.phase === 'transcribing') return 'Transcribing…';
  if (p.phase === 'scoring') return 'Scoring moments…';
  if (p.phase === 'burning') return `Burning captions… ${p.percent || 0}%`;
  if (p.phase === 'cutting') return `Cutting clip ${p.index || 1}/${p.total || 1}… ${p.percent || 0}%`;
  if (p.phase === 'done') return 'Done';
  return p.phase || '';
}

// Rough CSS approximation of the ffmpeg/libass output — not pixel-perfect,
// but enough to see roughly where captions will land before burning them in.
const CAPTION_PREVIEW_SAMPLE = { line: 'This is a sample caption line', word: 'WORD' };
const CAPTION_PRESETS = { top: { xPct: 0.5, yPct: 0.12 }, middle: { xPct: 0.5, yPct: 0.5 }, bottom: { xPct: 0.5, yPct: 0.88 } };

let captionsPos = { ...CAPTION_PRESETS.bottom }; // fractions of the player, drag-updated
let captionsDrag = null;

function updateCaptionsPreview() {
  const preview = $('#captions-preview');
  if (preview.classList.contains('hidden')) return;

  const style = $('#captions-style').value;
  const mode = $('#captions-mode').value;
  const size = parseInt($('#captions-size').value, 10);
  $('#captions-size-label').textContent = size + 'px';

  preview.className = 'captions-preview style-' + style + (captionsDrag ? ' dragging' : '');
  const text = CAPTION_PREVIEW_SAMPLE[mode] || CAPTION_PREVIEW_SAMPLE.line;
  preview.innerHTML = style === 'black-box' ? `<span>${text}</span>` : text;

  preview.style.left = (captionsPos.xPct * 100) + '%';
  preview.style.top = (captionsPos.yPct * 100) + '%';

  const player = $('#player');
  const videoH = player.videoHeight || 720;
  const renderedH = player.clientHeight || 360;
  const scaled = size * (renderedH / videoH);
  preview.style.fontSize = Math.max(10, Math.round(scaled)) + 'px';
}

['captions-style', 'captions-mode', 'captions-size'].forEach((id) => {
  $('#' + id).addEventListener('input', updateCaptionsPreview);
});
$('#player').addEventListener('loadedmetadata', updateCaptionsPreview);

document.querySelectorAll('.chip[data-caption-preset]').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-caption-preset]').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    captionsPos = { ...CAPTION_PRESETS[chip.dataset.captionPreset] };
    updateCaptionsPreview();
  });
});

$('#captions-preview').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  document.querySelectorAll('.chip[data-caption-preset]').forEach((c) => c.classList.remove('active'));
  const wrap = $('#player-wrap');
  captionsDrag = { startX: e.clientX, startY: e.clientY, startPos: { ...captionsPos }, w: wrap.clientWidth, h: wrap.clientHeight };
  updateCaptionsPreview();
});
window.addEventListener('pointermove', (e) => {
  if (!captionsDrag) return;
  const dx = (e.clientX - captionsDrag.startX) / captionsDrag.w;
  const dy = (e.clientY - captionsDrag.startY) / captionsDrag.h;
  captionsPos.xPct = Math.min(0.97, Math.max(0.03, captionsDrag.startPos.xPct + dx));
  captionsPos.yPct = Math.min(0.97, Math.max(0.03, captionsDrag.startPos.yPct + dy));
  updateCaptionsPreview();
});
window.addEventListener('pointerup', () => {
  if (!captionsDrag) return;
  captionsDrag = null;
  updateCaptionsPreview();
});

$('#add-captions').addEventListener('click', async () => {
  if (!currentItem || capturingCaptions) return;
  capturingCaptions = true;
  const progWrap = $('#captions-progress');
  const fill = $('#captions-progress-fill');
  const label = $('#captions-progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '2%';
  label.textContent = 'Starting…';
  $('#add-captions').disabled = true;

  try {
    const res = await window.api.burnCaptions({
      input: currentItem.path,
      replace: $('#captions-replace').checked,
      style: $('#captions-style').value,
      mode: $('#captions-mode').value,
      xPct: captionsPos.xPct,
      yPct: captionsPos.yPct,
      fontSize: parseInt($('#captions-size').value, 10)
    });
    fill.style.width = '100%';
    label.textContent = 'Done → ' + res.output.split(/[\\/]/).pop() + ' (' + fmtSize(res.size) + ')';
    toast('Captions added');
    renderLibrary();
  } catch (err) {
    label.textContent = 'Captioning failed';
    toast('Add Captions failed: ' + err.message, true, 6000);
  } finally {
    capturingCaptions = false;
    $('#add-captions').disabled = false;
  }
});

window.api.onCaptionsProgress((p) => {
  if (!capturingCaptions) return;
  const fill = $('#captions-progress-fill');
  const label = $('#captions-progress-label');
  if (typeof p.percent === 'number') fill.style.width = p.percent + '%';
  label.textContent = describeProgress(p);
});

// ---------------------------------------------------------------------------
// Make Reels (local heuristic viral-clip generator)
// ---------------------------------------------------------------------------
$('#make-reels').addEventListener('click', async () => {
  if (!currentItem || makingReels) return;
  makingReels = true;
  const progWrap = $('#reels-progress');
  const fill = $('#reels-progress-fill');
  const label = $('#reels-progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '2%';
  label.textContent = 'Starting…';
  $('#make-reels').disabled = true;

  try {
    const res = await window.api.makeReels({
      input: currentItem.path,
      maxLength: parseInt($('#reel-length').value, 10)
    });
    const n = res.clips.length;
    const capped = res.consideredCandidates > res.cappedAt;
    const msg = n
      ? `Made ${n} reel${n === 1 ? '' : 's'}` + (capped ? ` (capped at ${res.cappedAt} — more candidates were found)` : '')
      : 'No standout moments found';
    fill.style.width = '100%';
    label.textContent = msg;
    toast(msg, !n, capped ? 6000 : 3200);
    renderLibrary();
  } catch (err) {
    label.textContent = 'Reel generation failed';
    toast('Make Reels failed: ' + err.message, true, 6000);
  } finally {
    makingReels = false;
    $('#make-reels').disabled = false;
  }
});

window.api.onReelsProgress((p) => {
  if (!makingReels) return;
  const fill = $('#reels-progress-fill');
  const label = $('#reels-progress-label');
  if (typeof p.percent === 'number') fill.style.width = p.percent + '%';
  label.textContent = describeProgress(p);
});

// ---------------------------------------------------------------------------
// Silence Editor — detect, review (trim/delete/undo), apply
// ---------------------------------------------------------------------------
let silenceItem = null;
let silenceDuration = 0;
let silences = []; // [{id, start, end}]
let silenceIdCounter = 0;
let deletedSilenceIds = new Set();
let undoStack = []; // ids, in delete order — undo pops the most recent
let detectingSilences = false;
let applyingSilenceCuts = false;

function openSilenceEditor(item) {
  if (!item) return;
  silenceItem = item;
  silences = [];
  deletedSilenceIds = new Set();
  undoStack = [];
  silenceDuration = 0;
  $('#silence-modal-title').textContent = 'Remove Silences — ' + item.name;
  $('#silence-player').src = item.url;
  $('#silence-replace').checked = false;
  $('#silence-progress').classList.add('hidden');
  renderSilenceList();
  $('#silence-modal').classList.remove('hidden');
}

function closeSilenceEditor() {
  const player = $('#silence-player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('#silence-modal').classList.add('hidden');
  silenceItem = null;
}

$('#open-silence-editor').addEventListener('click', () => openSilenceEditor(currentItem));
$('#silence-modal-close').addEventListener('click', closeSilenceEditor);
$('#silence-modal').addEventListener('click', (e) => { if (e.target === $('#silence-modal')) closeSilenceEditor(); });

function fmtT(t) { return t.toFixed(2); }

function renderSilenceTimeline() {
  const wrap = $('#silence-timeline');
  const track = $('#silence-timeline-track');
  if (!silences.length || !silenceDuration) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  track.innerHTML = '';
  for (const s of silences) {
    const el = document.createElement('div');
    el.className = 'silence-seg' + (deletedSilenceIds.has(s.id) ? ' deleted' : '');
    el.style.left = (s.start / silenceDuration * 100) + '%';
    el.style.width = Math.max(0.3, (s.end - s.start) / silenceDuration * 100) + '%';
    el.title = `${fmtT(s.start)}s → ${fmtT(s.end)}s`;
    track.appendChild(el);
  }
}

function renderSilenceList() {
  const list = $('#silence-list');
  renderSilenceTimeline();

  const deletedCount = [...deletedSilenceIds].length;
  $('#silence-undo').disabled = undoStack.length === 0;
  $('#apply-silence-cuts').disabled = deletedCount === 0 || applyingSilenceCuts;

  if (!silences.length) {
    list.innerHTML = '<div class="empty">Click "Detect Silences" to scan this clip.</div>';
    return;
  }

  list.innerHTML = '';
  silences.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'silence-row' + (deletedSilenceIds.has(s.id) ? ' deleted' : '');

    const idx = document.createElement('span');
    idx.className = 'silence-index';
    idx.textContent = '#' + (i + 1);

    const time = document.createElement('span');
    time.className = 'silence-time';
    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.step = '0.1'; startInput.min = '0';
    startInput.value = fmtT(s.start);
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    const endInput = document.createElement('input');
    endInput.type = 'number'; endInput.step = '0.1'; endInput.min = '0';
    endInput.value = fmtT(s.end);
    time.append(startInput, arrow, endInput);

    const onTrim = () => {
      let newStart = Math.max(0, parseFloat(startInput.value) || 0);
      let newEnd = Math.max(0, parseFloat(endInput.value) || 0);
      if (silenceDuration) { newStart = Math.min(newStart, silenceDuration); newEnd = Math.min(newEnd, silenceDuration); }
      if (newEnd <= newStart) newEnd = newStart + 0.1;
      s.start = newStart; s.end = newEnd;
      startInput.value = fmtT(s.start); endInput.value = fmtT(s.end);
      renderSilenceTimeline();
    };
    startInput.addEventListener('change', onTrim);
    endInput.addEventListener('change', onTrim);

    const dur = document.createElement('span');
    dur.className = 'silence-dur';
    dur.textContent = fmtT(s.end - s.start) + 's';

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'ghost-btn';
    previewBtn.textContent = '▶';
    previewBtn.title = 'Preview this segment';
    previewBtn.addEventListener('click', () => {
      const player = $('#silence-player');
      player.currentTime = s.start;
      player.play();
      const onTick = () => {
        if (player.currentTime >= s.end) { player.pause(); player.removeEventListener('timeupdate', onTick); }
      };
      player.addEventListener('timeupdate', onTick);
    });

    const delBtn = document.createElement('button');
    const isDeleted = deletedSilenceIds.has(s.id);
    delBtn.className = isDeleted ? 'ghost-btn' : 'danger-btn';
    delBtn.textContent = isDeleted ? 'Restore' : 'Delete';
    delBtn.addEventListener('click', () => {
      if (deletedSilenceIds.has(s.id)) {
        deletedSilenceIds.delete(s.id);
        undoStack = undoStack.filter((id) => id !== s.id);
      } else {
        deletedSilenceIds.add(s.id);
        undoStack.push(s.id);
      }
      renderSilenceList();
    });

    row.append(idx, time, dur, spacer, previewBtn, delBtn);
    list.appendChild(row);
  });
}

$('#detect-silences').addEventListener('click', async () => {
  if (!silenceItem || detectingSilences) return;
  detectingSilences = true;
  $('#detect-silences').disabled = true;
  $('#silence-list').innerHTML = '<div class="empty">Scanning for silence…</div>';
  try {
    const res = await window.api.detectSilences({
      input: silenceItem.path,
      sensitivity: $('#silence-sensitivity').value,
      minDuration: parseFloat($('#silence-min-len').value)
    });
    silenceDuration = res.duration || 0;
    silences = res.silences.map((s) => ({ id: silenceIdCounter++, start: s.start, end: s.end }));
    deletedSilenceIds = new Set();
    undoStack = [];
    renderSilenceList();
    toast(silences.length ? `Found ${silences.length} silence${silences.length === 1 ? '' : 's'}` : 'No silences found');
  } catch (err) {
    $('#silence-list').innerHTML = '<div class="empty">Detection failed: ' + err.message + '</div>';
    toast('Detect Silences failed: ' + err.message, true, 6000);
  } finally {
    detectingSilences = false;
    $('#detect-silences').disabled = false;
  }
});

$('#silence-undo').addEventListener('click', () => {
  if (!undoStack.length) return;
  const id = undoStack.pop();
  deletedSilenceIds.delete(id);
  renderSilenceList();
});

$('#apply-silence-cuts').addEventListener('click', async () => {
  if (!silenceItem || applyingSilenceCuts) return;
  const cuts = silences.filter((s) => deletedSilenceIds.has(s.id)).map((s) => ({ start: s.start, end: s.end }));
  if (!cuts.length) return;
  applyingSilenceCuts = true;
  const progWrap = $('#silence-progress');
  const fill = $('#silence-progress-fill');
  const label = $('#silence-progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '2%';
  label.textContent = 'Removing… 0%';
  $('#apply-silence-cuts').disabled = true;

  try {
    const res = await window.api.applySilenceCuts({
      input: silenceItem.path,
      cuts,
      replace: $('#silence-replace').checked
    });
    fill.style.width = '100%';
    label.textContent = 'Done → ' + res.output.split(/[\\/]/).pop() + ' (' + fmtSize(res.size) + ')';
    toast(`Removed ${cuts.length} silence${cuts.length === 1 ? '' : 's'}`);
    renderLibrary();
    closeSilenceEditor();
  } catch (err) {
    label.textContent = 'Apply failed';
    toast('Apply Cuts failed: ' + err.message, true, 6000);
  } finally {
    applyingSilenceCuts = false;
    $('#apply-silence-cuts').disabled = deletedSilenceIds.size === 0;
  }
});

window.api.onSilenceProgress((p) => {
  if (!applyingSilenceCuts) return;
  const fill = $('#silence-progress-fill');
  const label = $('#silence-progress-label');
  if (typeof p.percent === 'number') { fill.style.width = p.percent + '%'; label.textContent = 'Removing… ' + p.percent + '%'; }
});

// ---------------------------------------------------------------------------
// Transcript Editor — Descript-style "delete the words, cut the video"
// ---------------------------------------------------------------------------
const TRANSCRIPT_GAP_THRESHOLD = 0.35; // seconds — pauses at least this long become a deletable chip

let transcriptItem = null;
let transcriptTokens = []; // [{id, kind:'word'|'gap', text, start, end}]
let transcriptDeleted = new Set(); // token ids marked for deletion
let transcriptUndoStack = []; // arrays of ids — each entry is one undo-able action
let transcriptLastClickedIdx = null;
let loadingTranscript = false;
let applyingTranscriptEdits = false;

function openTranscriptEditor(item) {
  if (!item) return;
  transcriptItem = item;
  transcriptTokens = [];
  transcriptDeleted = new Set();
  transcriptUndoStack = [];
  transcriptLastClickedIdx = null;
  $('#transcript-modal-title').textContent = 'Edit Transcript — ' + item.name;
  $('#transcript-player').src = item.url;
  $('#transcript-replace').checked = false;
  $('#transcript-progress').classList.add('hidden');
  renderTranscriptBody();
  $('#transcript-modal').classList.remove('hidden');
}

function closeTranscriptEditor() {
  const player = $('#transcript-player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('#transcript-modal').classList.add('hidden');
  transcriptItem = null;
}

$('#open-transcript-editor').addEventListener('click', () => openTranscriptEditor(currentItem));
$('#transcript-modal-close').addEventListener('click', closeTranscriptEditor);
$('#transcript-modal').addEventListener('click', (e) => { if (e.target === $('#transcript-modal')) closeTranscriptEditor(); });

function buildTranscriptTokens(words) {
  const tokens = [];
  let id = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    tokens.push({ id: id++, kind: 'word', text: w.text, start: w.start, end: w.end });
    if (i < words.length - 1) {
      const gapStart = w.end;
      const gapEnd = words[i + 1].start;
      if (gapEnd - gapStart >= TRANSCRIPT_GAP_THRESHOLD) {
        tokens.push({ id: id++, kind: 'gap', text: '⏸ ' + (gapEnd - gapStart).toFixed(1) + 's', start: gapStart, end: gapEnd });
      }
    }
  }
  return tokens;
}

function renderTranscriptBody() {
  const body = $('#transcript-body');
  const deletedCount = transcriptTokens.filter((t) => transcriptDeleted.has(t.id)).length;
  $('#transcript-undo').disabled = transcriptUndoStack.length === 0;
  $('#apply-transcript-edits').disabled = deletedCount === 0 || applyingTranscriptEdits;

  if (!transcriptTokens.length) {
    body.innerHTML = loadingTranscript
      ? '<div class="empty">Transcribing…</div>'
      : '<div class="empty">Click "Transcribe &amp; Load" to load this clip\'s transcript.</div>';
    return;
  }

  body.innerHTML = '';
  transcriptTokens.forEach((tok, idx) => {
    const span = document.createElement('span');
    span.className = 'transcript-token ' + (tok.kind === 'gap' ? 'gap-token' : 'word-token') + (transcriptDeleted.has(tok.id) ? ' deleted' : '');
    span.textContent = tok.kind === 'gap' ? tok.text : tok.text + ' ';
    span.addEventListener('click', (e) => onTranscriptTokenClick(idx, e.shiftKey));
    body.appendChild(span);
  });
}

function onTranscriptTokenClick(idx, shiftKey) {
  if (shiftKey && transcriptLastClickedIdx != null) {
    const [from, to] = [transcriptLastClickedIdx, idx].sort((a, b) => a - b);
    const batch = [];
    for (let i = from; i <= to; i++) {
      const id = transcriptTokens[i].id;
      if (!transcriptDeleted.has(id)) { transcriptDeleted.add(id); batch.push(id); }
    }
    if (batch.length) transcriptUndoStack.push(batch);
  } else {
    const id = transcriptTokens[idx].id;
    if (transcriptDeleted.has(id)) {
      transcriptDeleted.delete(id);
      transcriptUndoStack = transcriptUndoStack.map((b) => b.filter((x) => x !== id)).filter((b) => b.length);
    } else {
      transcriptDeleted.add(id);
      transcriptUndoStack.push([id]);
    }
  }
  transcriptLastClickedIdx = idx;
  renderTranscriptBody();
}

$('#load-transcript').addEventListener('click', async () => {
  if (!transcriptItem || loadingTranscript) return;
  loadingTranscript = true;
  $('#load-transcript').disabled = true;
  renderTranscriptBody();
  try {
    const transcript = await window.api.transcribe(transcriptItem.path);
    transcriptTokens = buildTranscriptTokens(transcript.words || []);
    transcriptDeleted = new Set();
    transcriptUndoStack = [];
    if (!transcriptTokens.length) toast('No speech detected in this clip', true);
  } catch (err) {
    toast('Transcribe failed: ' + err.message, true, 6000);
  } finally {
    loadingTranscript = false;
    $('#load-transcript').disabled = false;
    renderTranscriptBody();
  }
});

$('#transcript-undo').addEventListener('click', () => {
  const batch = transcriptUndoStack.pop();
  if (!batch) return;
  batch.forEach((id) => transcriptDeleted.delete(id));
  renderTranscriptBody();
});

function mergedTranscriptCuts() {
  const ranges = transcriptTokens
    .filter((t) => transcriptDeleted.has(t.id))
    .map((t) => ({ start: t.start, end: t.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

$('#apply-transcript-edits').addEventListener('click', async () => {
  if (!transcriptItem || applyingTranscriptEdits) return;
  const cuts = mergedTranscriptCuts();
  if (!cuts.length) return;
  applyingTranscriptEdits = true;
  const progWrap = $('#transcript-progress');
  const fill = $('#transcript-progress-fill');
  const label = $('#transcript-progress-label');
  progWrap.classList.remove('hidden');
  fill.style.width = '2%';
  label.textContent = 'Removing… 0%';
  $('#apply-transcript-edits').disabled = true;

  try {
    const res = await window.api.applySilenceCuts({
      input: transcriptItem.path,
      cuts,
      replace: $('#transcript-replace').checked
    });
    fill.style.width = '100%';
    label.textContent = 'Done → ' + res.output.split(/[\\/]/).pop() + ' (' + fmtSize(res.size) + ')';
    toast(`Applied ${cuts.length} edit${cuts.length === 1 ? '' : 's'}`);
    renderLibrary();
    closeTranscriptEditor();
  } catch (err) {
    label.textContent = 'Apply failed';
    toast('Apply Edits failed: ' + err.message, true, 6000);
  } finally {
    applyingTranscriptEdits = false;
    $('#apply-transcript-edits').disabled = transcriptDeleted.size === 0;
  }
});

window.api.onSilenceProgress((p) => {
  if (!applyingTranscriptEdits) return;
  const fill = $('#transcript-progress-fill');
  const label = $('#transcript-progress-label');
  if (typeof p.percent === 'number') { fill.style.width = p.percent + '%'; label.textContent = 'Removing… ' + p.percent + '%'; }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadSources();
loadDevices().then(() => { updateRecordButton(); updateHint(); startLiveCameraPreview(); });
loadOutputDir();
renderLibrary();
loadLiveSources();
