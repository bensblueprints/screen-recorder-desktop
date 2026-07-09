const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const LICENSE_API_URL = process.env.BLOOMRECORDER_LICENSE_API || 'https://bloomrecorder-license.advancedmarketing.co/validate';

function licenseFile() {
  return path.join(app.getPath('userData'), 'license.json');
}

function readLicense() {
  try { return JSON.parse(fs.readFileSync(licenseFile(), 'utf8')); } catch { return null; }
}

function writeLicense(data) {
  fs.writeFileSync(licenseFile(), JSON.stringify(data, null, 2));
}

function getOrCreateHwid() {
  const existing = readLicense();
  if (existing?.hwid) return existing.hwid;
  return crypto.randomUUID();
}

// A packaged build with no valid stored license requires activation.
// Unpackaged (npm start / dev) always skips the gate.
function requiresActivation() {
  if (!app.isPackaged && !process.env.BLOOMRECORDER_FORCE_LICENSE) return false;
  const license = readLicense();
  return !license?.valid;
}

async function activate(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { valid: false, reason: 'empty' };

  const hwid = getOrCreateHwid();

  let res;
  try {
    res = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: trimmed, hwid })
    });
  } catch (err) {
    return { valid: false, reason: 'network_error' };
  }

  let body;
  try { body = await res.json(); } catch { body = { valid: false, reason: 'bad_response' }; }

  if (body.valid) {
    writeLicense({ key: trimmed, hwid, valid: true, validatedAt: Date.now() });
  }
  return body;
}

module.exports = { requiresActivation, activate, readLicense };
