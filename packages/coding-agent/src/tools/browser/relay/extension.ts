/**
 * Relay extension materialization.
 *
 * The OMP Browser Relay extension ships embedded in the CLI (the same assets
 * `omp browser-relay install` writes out). This module centralizes the file
 * map + writer so the /pentest prerequisite gate can materialize the
 * extension on demand and launch the built-in Chromium with it pre-loaded —
 * no manual chrome://extensions step required for the managed-browser path.
 */
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import backgroundJs from "./extension-assets/background.js.txt" with { type: "text" };
import licenseText from "./extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "./extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "./extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "./extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "./extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };

/** Unpacked-extension file map: filename → embedded content. */
export const RELAY_EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	LICENSE: licenseText,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
	"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
};

/** Default materialized extension dir: ~/.omp-cyberstrike/browser-relay/extension. */
export function relayExtensionDir(): string {
	return path.join(getBrowserRelayDir(), "extension");
}

/** Write the embedded extension files into `dir` (idempotent). */
export function writeRelayExtension(dir: string): void {
	for (const name in RELAY_EXTENSION_FILES) {
		Bun.write(path.join(dir, name), RELAY_EXTENSION_FILES[name]!);
	}
}
