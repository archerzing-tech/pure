// src/shared/platformUa.ts
// Platform-appropriate browser User-Agent for all outbound web requests.
// Search engines and many sites block the bare "Pure/1.0" string; a real
// browser UA keeps both search backends and web_fetch targets responsive.
//
// The UA is chosen per-platform so that the OS token in the string matches
// the actual runtime — a Windows IP sending a macOS UA is a contradiction
// signal that advanced bot detection (Cloudflare, etc.) flags.
//
// Chrome version tracks the current stable channel (verified via the
// Google versionhistory API). Both platforms share the same Chrome major
// version; only the OS token differs.
//
// Windows 10/11  → "Windows NT 10.0; Win64; x64"
// macOS 13+      → "Macintosh; Intel Mac OS X 10_15_7"

const CHROME_VERSION = '152.0.7977.54';

const WINDOWS_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const MACOS_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const LINUX_UA =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

/** Returns a browser User-Agent string appropriate for the current platform.
 *  Used by all web_fetch / web_search / public-API fetches. */
export function getBrowserUa(): string {
  if (typeof process !== 'undefined' && process.platform) {
    if (process.platform === 'win32') return WINDOWS_UA;
    if (process.platform === 'darwin') return MACOS_UA;
    if (process.platform === 'linux') return LINUX_UA;
  }
  if (typeof navigator !== 'undefined') {
    if (/Windows/i.test(navigator.userAgent)) return WINDOWS_UA;
    if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) return MACOS_UA;
    if (/Linux/i.test(navigator.userAgent)) return LINUX_UA;
  }
  return MACOS_UA;
}

/** Fixed UA for environments where platform detection is not yet available
 *  (e.g. module-load-time const initialization in contexts where process /
 *  navigator may be unavailable). Defaults to macOS as the prior behavior. */
export const BROWSER_UA = getBrowserUa();
