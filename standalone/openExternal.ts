/**
 * Open an external URL in a specific browser from the hub process.
 *
 * The dashboard webview runs inside whatever browser the user launched it in
 * (e.g. Firefox), so a webview-side `window.open` would open ticket links there.
 * The user does their actual ticket work in Chrome, so we route "open in
 * ClickUp" through the server and shell out to launch the URL in the configured
 * browser instead.
 */

import { execFile } from 'child_process';
import { EXTERNAL_BROWSER_APP } from './constants.js';

/**
 * Launch `url` in EXTERNAL_BROWSER_APP. macOS uses `open -a <app>`; other
 * platforms fall back to the OS default handler. URL is passed as an argv entry
 * (never interpolated into a shell string) and validated to be http(s) first.
 */
export function openUrlInExternalBrowser(url: string): void {
	if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
		console.warn(`[openExternal] Ignoring non-http(s) url: ${String(url).slice(0, 80)}`);
		return;
	}

	if (process.platform === 'darwin') {
		execFile('open', ['-a', EXTERNAL_BROWSER_APP, url], (err) => {
			if (err) {
				// Chrome may not be installed — fall back to the default browser.
				console.warn(`[openExternal] "${EXTERNAL_BROWSER_APP}" launch failed, using default: ${err.message}`);
				execFile('open', [url], () => {});
			}
		});
		return;
	}

	if (process.platform === 'win32') {
		// `start` is a cmd builtin; the empty "" is the window-title arg.
		execFile('cmd', ['/c', 'start', '', url], () => {});
		return;
	}

	execFile('xdg-open', [url], () => {});
}
