/**
 * Managed-Chromium launcher for the browser relay.
 *
 * The /pentest prerequisite gate (src/pentest/prerequisites.ts) launches the
 * fork's BUILT-IN playwright Chromium (chromium-1208 — the same browser the
 * hackbrowser crawler ships: release sidecar `omp-browser-deps-<tag>.tar.gz`,
 * Docker dev image, or the per-OS ms-playwright cache) with the relay
 * extension pre-loaded via `--load-extension`. No manual chrome://extensions
 * step and no dependency on the user's Chrome: the extension dials the relay
 * daemon and the gate's handshake wait passes.
 *
 * The user's own Chrome + manually-installed extension remains a supported
 * alternative: whenever it is already connected to the relay, the gate's
 * quick probe succeeds and nothing is launched.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which, getBrowserRelayDir, logger } from "@oh-my-pi/pi-utils";
import { resolveSystemChromium } from "../launch";
import { relayExtensionDir, writeRelayExtension } from "./extension";

/** Playwright's pinned chromium build for playwright 1.58.2 (matches web-crawl.ts). */
const CHROMIUM_CACHE_DIR = "chromium-1208";

/** Persistent omp-owned profile dir: logins and tabs survive across /pentest runs. */
const RELAY_CHROMIUM_PROFILE_DIR = path.join(getBrowserRelayDir(), "profile");

/** Platform binary layout inside a playwright chromium install dir. */
function chromiumBinaryCandidates(cacheDir: string): string[] {
	switch (process.platform) {
		case "win32":
			return [path.join(cacheDir, "chrome-win64", "chrome.exe"), path.join(cacheDir, "chrome-win", "chrome.exe")];
		case "darwin":
			return [
				path.join(
					cacheDir,
					"chrome-mac",
					"Google Chrome for Testing.app",
					"Contents",
					"MacOS",
					"Google Chrome for Testing",
				),
				path.join(
					cacheDir,
					"chrome-mac-arm64",
					"Google Chrome for Testing.app",
					"Contents",
					"MacOS",
					"Google Chrome for Testing",
				),
				path.join(cacheDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
			];
		default:
			return [path.join(cacheDir, "chrome-linux64", "chrome"), path.join(cacheDir, "chrome-linux", "chrome")];
	}
}

/** Candidate ms-playwright cache roots, in precedence order. */
function playwrightCacheRoots(): string[] {
	const roots: string[] = [];
	const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (env) roots.push(env);
	// Release sidecar layout: <exeDir>/browser-deps/ms-playwright (pre-extracted).
	roots.push(path.join(path.dirname(process.execPath), "browser-deps", "ms-playwright"));
	// Platform defaults (playwright's own cache locations).
	switch (process.platform) {
		case "win32":
			roots.push(
				path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright"),
			);
			break;
		case "darwin":
			roots.push(path.join(os.homedir(), "Library", "Caches", "ms-playwright"));
			break;
		default:
			roots.push(path.join(os.homedir(), ".cache", "ms-playwright"));
	}
	return roots;
}

/** Resolve the built-in playwright chromium executable, or undefined when absent. */
export async function resolvePlaywrightChromiumExecutable(): Promise<string | undefined> {
	for (const root of playwrightCacheRoots()) {
		for (const candidate of chromiumBinaryCandidates(path.join(root, CHROMIUM_CACHE_DIR))) {
			if (await Bun.file(candidate).exists()) return candidate;
		}
	}
	return undefined;
}

/**
 * Launch a headed Chromium with the relay extension pre-loaded, best-effort.
 *
 * Resolves the built-in playwright chromium first (the fork ships it), then
 * falls back to the system Chrome/Chromium (platform-native resolution). On
 * Linux without DISPLAY, wraps the launch in xvfb-run (same fallback the
 * crawler's headed mode uses). Never throws: the caller's handshake wait is
 * the arbiter.
 */
export async function launchRelayChromium(): Promise<void> {
	try {
		const executable = (await resolvePlaywrightChromiumExecutable()) ?? (await resolveSystemChromium());
		if (!executable) return;

		// Materialize the extension (idempotent) so --load-extension has an
		// unpacked dir to point at.
		const extensionDir = relayExtensionDir();
		writeRelayExtension(extensionDir);

		const args = [
			executable,
			`--user-data-dir=${RELAY_CHROMIUM_PROFILE_DIR}`,
			`--load-extension=${extensionDir}`,
			`--disable-extensions-except=${extensionDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-session-crashed-bubble",
			"--disable-features=TranslateUI",
			// Containers/dev images run as root: chromium refuses the sandbox
			// there (the crawler's bundle needs the same flags).
			...(process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0
				? ["--no-sandbox", "--disable-dev-shm-usage"]
				: []),
		];
		// Headless Linux (no DISPLAY): wrap in xvfb-run when the tooling exists
		// (xvfb-run needs xauth — a missing pair would fail silently otherwise).
		const wantsXvfb =
			process.platform !== "win32" &&
			process.platform !== "darwin" &&
			!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY;
		const useXvfb = wantsXvfb && (await $which("xvfb-run")) !== null && (await $which("xauth")) !== null;

		// A second launch against the same user-data-dir while the managed
		// chromium is already running forwards to the existing instance and
		// exits — profile locking makes the launch idempotent.
		const proc = useXvfb
			? Bun.spawn(["xvfb-run", "-a", ...args], { stdio: ["ignore", "ignore", "ignore"], detached: true })
			: Bun.spawn(args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
		proc.unref?.();
		// A wrapper (xvfb-run) or chromium that dies within ~1s means the launch
		// cannot succeed — surface it instead of letting the gate's handshake
		// wait burn the full budget in silence.
		Bun.sleep(1_000).then(() => {
			if (proc.exitCode !== null) {
				logger.warn("relay chromium exited immediately after launch", { exitCode: proc.exitCode });
			}
		});
	} catch {
		// Best-effort: the gate's handshake wait decides; failure surfaces with
		// the relay setup instructions.
	}
}
