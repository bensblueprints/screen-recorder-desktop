// electron-builder's normal icon-embedding step (rcedit, run as part of
// signAndEditExecutable) is bundled inside the same winCodeSign package as
// the macOS code-signing tools. Extracting that package needs the "create
// symbolic link" privilege (off by default without Developer Mode / admin),
// so a plain `electron-builder --win nsis` either hangs retrying that
// download or silently ships an icon-less exe if signAndEditExecutable is
// disabled to dodge the hang. This script does it in three steps instead:
// package with signing/rcedit off, patch the icon in directly via the
// standalone `rcedit` npm package (no winCodeSign involved), then repackage
// just the NSIS installer from the now-patched unpacked build.
const path = require('path');
const { execFileSync } = require('child_process');
const { rcedit } = require('rcedit');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'BloomRecorder.exe');
const icon = path.join(root, 'build', 'icon.ico');

function run(cmd, args) {
  const bin = process.platform === 'win32' ? `${cmd}.cmd` : cmd;
  execFileSync(bin, args, { stdio: 'inherit', cwd: root });
}

(async () => {
  console.log('[1/3] Packaging...');
  run('npx', ['electron-builder', '--win', 'nsis']);

  console.log('[2/3] Patching the app icon into the unpacked exe via rcedit...');
  await rcedit(exe, { icon });

  console.log('[3/3] Repackaging the NSIS installer from the icon-patched build...');
  run('npx', ['electron-builder', '--win', 'nsis', '--prepackaged', path.join('dist', 'win-unpacked')]);

  console.log('Done — dist/BloomRecorder Setup ' + require(path.join(root, 'package.json')).version + '.exe');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
