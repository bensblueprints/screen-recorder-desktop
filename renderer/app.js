/* Screen Recorder — renderer logic */
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sources = [];
let sourceKind = 'screen';
let selectedSource = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let audioCtx = null;
let timerInterval = null;
let recordStartedAt = 0;
let currentItem = null; // library item open in modal
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
// Source picker
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
      $('#record-btn').disabled = false;
      $('#record-hint').textContent = 'Selected: ' + s.name;
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
// Recording
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

async function startRecording() {
  if (!selectedSource) return;
  const withMic = $('#mic-toggle').checked;

  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    toast('Could not capture that source: ' + err.message, true);
    return;
  }

  // Mix system audio (if any) + microphone into a single audio track.
  const tracks = [display.getVideoTracks()[0]];
  const audioSources = [];
  if (display.getAudioTracks().length) audioSources.push(new MediaStream([display.getAudioTracks()[0]]));

  let micStream = null;
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      audioSources.push(micStream);
    } catch (err) {
      toast('Mic unavailable, recording without it (' + err.message + ')', true);
    }
  }

  if (audioSources.length) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    for (const s of audioSources) audioCtx.createMediaStreamSource(s).connect(dest);
    tracks.push(dest.stream.getAudioTracks()[0]);
  }

  recordingStream = new MediaStream(tracks);
  recordingStream._extra = { display, micStream };

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(recordingStream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 8_000_000
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = onRecorderStopped;

  // If the user stops sharing from the OS layer, stop cleanly too.
  display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());

  mediaRecorder.start(1000);
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
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function onRecorderStopped() {
  clearInterval(timerInterval);
  window.api.recordingStopped();

  const { display, micStream } = recordingStream._extra || {};
  [display, micStream, recordingStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }

  const btn = $('#record-btn');
  btn.classList.remove('recording');
  $('#record-btn-label').textContent = 'Start recording';
  $('#rec-timer').classList.add('hidden');

  if (!recordedChunks.length) { toast('Nothing was recorded.', true); return; }

  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  recordedChunks = [];
  try {
    const buf = await blob.arrayBuffer();
    const file = await window.api.saveRecording(buf);
    toast('Saved to library: ' + file.split(/[\\/]/).pop());
    switchView('library');
  } catch (err) {
    toast('Failed to save recording: ' + err.message, true);
  }
  mediaRecorder = null;
  recordingStream = null;
}

$('#record-btn').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
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
renderLibrary();
