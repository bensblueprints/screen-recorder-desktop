const keyInput = document.getElementById('key');
const errorEl = document.getElementById('error');
const activateBtn = document.getElementById('activate');
const buyLink = document.getElementById('buy-link');

const REASON_MESSAGES = {
  empty: 'Enter a license key.',
  hwid_mismatch: 'This key is already activated on another computer.',
  not_found: 'That license key was not found.',
  rate_limited: 'Too many attempts — wait a minute and try again.',
  network_error: 'Could not reach the license server. Check your connection.',
  service_unavailable: 'License server is temporarily unavailable. Try again shortly.',
  bad_response: 'Unexpected response from the license server.'
};

async function submit() {
  const key = keyInput.value.trim();
  errorEl.textContent = '';
  activateBtn.disabled = true;
  activateBtn.textContent = 'Activating…';
  try {
    const result = await window.api.activateLicense(key);
    if (!result.valid) {
      errorEl.textContent = REASON_MESSAGES[result.reason] || 'Invalid license key.';
    }
    // On success the main process closes this window and opens the app.
  } finally {
    activateBtn.disabled = false;
    activateBtn.textContent = 'Activate';
  }
}

activateBtn.addEventListener('click', submit);
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
buyLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://bloomrecorder.com');
});
