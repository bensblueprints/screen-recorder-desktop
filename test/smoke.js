/**
 * Smoke test: verifies the full ffmpeg export pipeline used by the app.
 *   1. Synthesize a 2s test WebM (VP9, testsrc pattern) — stands in for a MediaRecorder capture.
 *   2. Convert it to MP4 (H.264) with the exact flags the app uses.
 *   3. Convert it to an optimized GIF (two-pass palettegen/paletteuse).
 *   4. Exercise trim (-ss/-t) on the MP4 path.
 * Asserts every output exists and is non-trivial in size.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ffmpeg = require('ffmpeg-static');
const tmp = path.join(__dirname, 'tmp');

function run(label, args) {
  process.stdout.write(`  ${label}... `);
  const t0 = Date.now();
  const res = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  });
  if (res.status !== 0) {
    console.log('FAIL');
    console.error(res.stderr || res.error);
    process.exit(1);
  }
  console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function assertFile(file, minBytes, label) {
  assert.ok(fs.existsSync(file), `${label}: ${file} was not created`);
  const size = fs.statSync(file).size;
  assert.ok(size >= minBytes, `${label}: ${file} is only ${size} bytes (expected >= ${minBytes})`);
  console.log(`  ✓ ${label}: ${path.basename(file)} (${(size / 1024).toFixed(1)} KB)`);
}

console.log('BloomRecorder smoke test');
console.log('ffmpeg binary:', ffmpeg);
assert.ok(fs.existsSync(ffmpeg), 'ffmpeg-static binary missing');

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const webm = path.join(tmp, 'test.webm');
const mp4 = path.join(tmp, 'test.mp4');
const gif = path.join(tmp, 'test.gif');
const trimmed = path.join(tmp, 'test-trim.mp4');
const palette = path.join(tmp, 'palette.png');

// 1. Synthesize source WebM (what MediaRecorder would produce)
run('synthesize 2s VP9 WebM', [
  '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8',
  webm
]);
assertFile(webm, 10_000, 'source WebM');

// 2. WebM -> MP4 (same flags as the app's exporter)
run('convert WebM -> MP4 (H.264)', [
  '-i', webm,
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  mp4
]);
assertFile(mp4, 10_000, 'MP4 export');

// 3. WebM -> optimized GIF (two-pass, same filters as the app)
const scale = 'fps=12,scale=960:-1:flags=lanczos';
run('GIF pass 1 (palettegen)', ['-i', webm, '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
assertFile(palette, 200, 'GIF palette');
run('GIF pass 2 (paletteuse)', [
  '-i', webm, '-i', palette,
  '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  gif
]);
assertFile(gif, 10_000, 'GIF export');

// 4. Trim path (-ss 0.5, -t 1.0) — same shape the app builds for trims
run('trim MP4 (0.5s -> 1.5s)', [
  '-ss', '0.5', '-i', webm, '-t', '1.0',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  trimmed
]);
assertFile(trimmed, 5_000, 'trimmed MP4');
const fullSize = fs.statSync(mp4).size;
const trimSize = fs.statSync(trimmed).size;
assert.ok(trimSize < fullSize, `trimmed file (${trimSize}) should be smaller than full export (${fullSize})`);
console.log('  ✓ trim reduces size as expected');

console.log('\nAll smoke tests passed.');
