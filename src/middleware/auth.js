/**
 * OTP Authentication Middleware (CLI bridge variant)
 *
 * Mirrors kiro-mobile-bridge/src/middleware/auth.js. Differences from the
 * IDE bridge:
 *  - Cookie name is `kcmb_session` (not `kmb_session`) so the two bridges
 *    can coexist on the same machine without clobbering each other.
 *  - Same single-use-OTP model, same rate limit, same timing-safe compares.
 */
import crypto from 'crypto';
import { OTP_MAX_ATTEMPTS, OTP_LOCKOUT_MS, SESSION_COOKIE } from '../utils/constants.js';

const authState = {
  otp: '',
  consumed: false,
  sessionToken: null
};

const rateLimitState = {
  attempts: 0,
  lockedUntil: 0
};

let authEnabled = true;

export function generateOTP() {
  const code = crypto.randomInt(100000, 999999 + 1);
  authState.otp = String(code);
  authState.consumed = false;
  authState.sessionToken = null;
  rateLimitState.attempts = 0;
  rateLimitState.lockedUntil = 0;
  return authState.otp;
}

export function getOTP() {
  return authState.otp;
}

export function setAuthEnabled(enabled) {
  authEnabled = enabled;
}

export function isAuthEnabled() {
  return authEnabled;
}

export function verifyOTP(code) {
  const now = Date.now();

  if (rateLimitState.lockedUntil > now) {
    const retryAfter = Math.ceil((rateLimitState.lockedUntil - now) / 1000);
    return { success: false, error: `Too many attempts. Try again in ${retryAfter}s.`, retryAfter };
  }

  if (rateLimitState.lockedUntil > 0 && rateLimitState.lockedUntil <= now) {
    rateLimitState.attempts = 0;
    rateLimitState.lockedUntil = 0;
  }

  if (authState.consumed) {
    rateLimitState.attempts++;
    if (rateLimitState.attempts >= OTP_MAX_ATTEMPTS) {
      rateLimitState.lockedUntil = now + OTP_LOCKOUT_MS;
      return {
        success: false,
        consumed: true,
        error: `Too many attempts. Try again in ${OTP_LOCKOUT_MS / 1000}s.`,
        retryAfter: OTP_LOCKOUT_MS / 1000
      };
    }
    return {
      success: false,
      consumed: true,
      error: 'Access code already used. Restart the server for a new code.'
    };
  }

  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    rateLimitState.attempts++;
    if (rateLimitState.attempts >= OTP_MAX_ATTEMPTS) {
      rateLimitState.lockedUntil = now + OTP_LOCKOUT_MS;
      return {
        success: false,
        error: `Too many attempts. Try again in ${OTP_LOCKOUT_MS / 1000}s.`,
        retryAfter: OTP_LOCKOUT_MS / 1000
      };
    }
    return { success: false, error: 'Invalid code format.' };
  }

  const codeBuffer = Buffer.from(code);
  const otpBuffer = Buffer.from(authState.otp);
  if (codeBuffer.length !== otpBuffer.length || !crypto.timingSafeEqual(codeBuffer, otpBuffer)) {
    rateLimitState.attempts++;
    if (rateLimitState.attempts >= OTP_MAX_ATTEMPTS) {
      rateLimitState.lockedUntil = now + OTP_LOCKOUT_MS;
      return {
        success: false,
        error: `Too many attempts. Try again in ${OTP_LOCKOUT_MS / 1000}s.`,
        retryAfter: OTP_LOCKOUT_MS / 1000
      };
    }
    return {
      success: false,
      error: `Invalid code. ${OTP_MAX_ATTEMPTS - rateLimitState.attempts} attempts remaining.`
    };
  }

  authState.consumed = true;
  authState.sessionToken = crypto.randomBytes(32).toString('hex');
  rateLimitState.attempts = 0;
  return { success: true, token: authState.sessionToken };
}

export function getRateLimitStatus() {
  const now = Date.now();
  if (rateLimitState.lockedUntil > now) {
    return {
      locked: true,
      consumed: authState.consumed,
      retryAfter: Math.ceil((rateLimitState.lockedUntil - now) / 1000)
    };
  }
  return { locked: false, consumed: authState.consumed, retryAfter: 0 };
}

export function validateSession(token) {
  if (!token || typeof token !== 'string') return false;
  if (!authState.sessionToken) return false;
  const tokenBuffer = Buffer.from(token);
  const sessionBuffer = Buffer.from(authState.sessionToken);
  if (tokenBuffer.length !== sessionBuffer.length) return false;
  return crypto.timingSafeEqual(tokenBuffer, sessionBuffer);
}

function parseSessionCookie(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const escaped = SESSION_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|;\\s*)${escaped}=([a-f0-9]{64})(?:;|$)`);
  const match = cookieHeader.match(re);
  return match ? match[1] : null;
}

const PUBLIC_PATHS = new Set(['/auth/login', '/auth/verify', '/auth/status']);

export function authMiddleware(req, res, next) {
  if (!authEnabled) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  const token = parseSessionCookie(req.headers.cookie);
  if (token && validateSession(token)) return next();

  const wantsJSON = req.headers.accept?.includes('application/json') ||
    req.headers['content-type']?.includes('application/json') ||
    req.xhr;

  if (wantsJSON) return res.status(401).json({ error: 'Authentication required' });
  return res.redirect('/auth/login');
}

export function validateWSAuth(req) {
  if (!authEnabled) return true;
  try {
    const token = parseSessionCookie(req.headers.cookie || '');
    return validateSession(token);
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export function getLoginPageHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1e1e1e">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Kiro CLI Mobile Bridge — Access Code</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%; overflow: hidden; background: #1e1e1e;
      font-family: "Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, Ubuntu, sans-serif;
      color: #cccccc;
    }
    .login-container {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; height: 100dvh; padding: 24px; text-align: center;
    }
    .logo { font-size: 28px; font-weight: 600; color: #ffffff; margin-bottom: 8px; }
    .subtitle { font-size: 13px; color: #888; margin-bottom: 40px; }
    .otp-label { font-size: 14px; color: #cccccc; margin-bottom: 16px; }
    .otp-inputs { display: flex; gap: 8px; margin-bottom: 24px; justify-content: center; }
    .otp-inputs input {
      width: 48px; height: 56px; text-align: center; font-size: 24px; font-weight: 600;
      background: #2d2d2d; border: 2px solid #3c3c3c; border-radius: 8px; color: #ffffff;
      outline: none; caret-color: #0078d4; transition: border-color 0.15s;
      -webkit-appearance: none; appearance: none;
    }
    .otp-inputs input:focus { border-color: #0078d4; }
    .otp-inputs input.error { border-color: #f44336; animation: shake 0.4s; }
    .otp-inputs input.success { border-color: #4caf50; }
    .error-message {
      color: #f44336; font-size: 13px; min-height: 20px; margin-bottom: 16px;
      transition: opacity 0.2s;
    }
    .status-message { color: #4caf50; font-size: 13px; min-height: 20px; margin-bottom: 16px; }
    .hint { font-size: 12px; color: #666; max-width: 280px; line-height: 1.5; }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-6px); }
      50% { transform: translateX(6px); }
      75% { transform: translateX(-4px); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .login-container { animation: fadeIn 0.3s ease-out; }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">Kiro CLI Mobile Bridge</div>
    <div class="subtitle">Remote terminal access</div>
    <div class="otp-label">Enter access code</div>
    <div class="otp-inputs" id="otpInputs">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="one-time-code" aria-label="Digit 1">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit 2">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit 3">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit 4">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit 5">
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit 6">
    </div>
    <div id="errorMsg" class="error-message"></div>
    <div class="hint">Check the terminal where you started the server for the 6-digit access code.</div>
  </div>
  <script>
    const inputs = document.querySelectorAll('#otpInputs input');
    const errorMsg = document.getElementById('errorMsg');
    let submitting = false;
    let lockoutTimer = null;

    (async () => {
      try {
        const res = await fetch('/auth/status');
        const data = await res.json();
        if (data.consumed) {
          showError('Access code already used. Restart the server for a new code.');
          inputs.forEach(i => { i.disabled = true; });
        } else if (data.locked && data.retryAfter > 0) {
          startLockoutCountdown(data.retryAfter);
        } else {
          inputs[0].focus();
        }
      } catch { inputs[0].focus(); }
    })();

    inputs.forEach((input, index) => {
      input.addEventListener('input', (e) => {
        const value = e.target.value.replace(/\\D/g, '');
        e.target.value = value.slice(-1);
        clearErrors();
        if (value && index < inputs.length - 1) inputs[index + 1].focus();
        if (getCode().length === 6) submitOTP();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!e.target.value && index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData('text') || '').replace(/\\D/g, '').slice(0, 6);
        if (pasted.length > 0) {
          for (let i = 0; i < inputs.length; i++) inputs[i].value = pasted[i] || '';
          const focusIndex = Math.min(pasted.length, inputs.length - 1);
          inputs[focusIndex].focus();
          if (pasted.length === 6) submitOTP();
        }
      });
    });

    function getCode() { return Array.from(inputs).map(i => i.value).join(''); }
    function clearErrors() {
      errorMsg.textContent = ''; errorMsg.className = 'error-message';
      inputs.forEach(i => i.classList.remove('error', 'success'));
    }
    function showError(msg) {
      errorMsg.textContent = msg; errorMsg.className = 'error-message';
      inputs.forEach(i => i.classList.add('error'));
    }
    function showSuccess() {
      errorMsg.textContent = 'Access granted.'; errorMsg.className = 'status-message';
      inputs.forEach(i => { i.classList.remove('error'); i.classList.add('success'); i.disabled = true; });
    }
    function startLockoutCountdown(seconds) {
      inputs.forEach(i => { i.disabled = true; i.value = ''; });
      let remaining = seconds;
      showError('Too many attempts. Try again in ' + remaining + 's.');
      if (lockoutTimer) clearInterval(lockoutTimer);
      lockoutTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(lockoutTimer); lockoutTimer = null;
          clearErrors();
          inputs.forEach(i => { i.disabled = false; });
          inputs[0].focus();
        } else {
          showError('Too many attempts. Try again in ' + remaining + 's.');
        }
      }, 1000);
    }
    async function submitOTP() {
      if (submitting || lockoutTimer) return;
      submitting = true;
      const code = getCode();
      try {
        const res = await fetch('/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ otp: code })
        });
        const data = await res.json();
        if (data.success) {
          showSuccess();
          setTimeout(() => { window.location.href = '/'; }, 600);
        } else if (data.consumed) {
          showError(data.error || 'Access code already used. Restart the server for a new code.');
          inputs.forEach(i => { i.disabled = true; i.value = ''; });
          if (data.retryAfter) startLockoutCountdown(data.retryAfter);
        } else if (data.retryAfter) {
          startLockoutCountdown(data.retryAfter);
        } else {
          showError(data.error || 'Invalid code.');
          inputs.forEach(i => i.value = '');
          inputs[0].focus();
        }
      } catch (err) {
        showError('Connection error. Please try again.');
      } finally {
        submitting = false;
      }
    }
  </script>
</body>
</html>`;
}
