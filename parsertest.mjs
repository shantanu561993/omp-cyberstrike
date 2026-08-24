import { extractTarGz } from "/work/omp-cyberstrike/packages/coding-agent/src/pentest/tar.ts";
import { readFileSync } from "node:fs";

// 1) embedded node_modules tarball (GNU tar format)
const b64 = readFileSync("/work/omp-cyberstrike/packages/hackbrowser/dist/node_modules.tar.gz.mjs", "utf8");
const out1 = "/tmp/x1";
extractTarGz(Buffer.from(b64, "base64"), out1);
const n1 = (await Bun.$`find ${out1} -type f | wc -l`.text()).trim();
console.log("node_modules entries written:", n1);

// 2) browser sidecar tar.gz (GNU tar -czf, like the CI linux rows)
const out2 = "/tmp/x2";
const files = extractTarGz(readFileSync("/work/verify/standalone/omp-browser-deps-linux-x64.tar.gz"), out2);
console.log("browser files written:", files.length);
const n2 = (await Bun.$`find ${out2} -type f | wc -l`.text()).trim();
console.log("browser fs count:", n2);

// spot-verify a real browser binary hash vs the reference extraction
const proc1 = await Bun.$`sha256sum ${out2}/ms-playwright/chromium-1208/chrome-linux64/chrome`.quiet();
const proc2 = await Bun.$`sha256sum /root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`.quiet();
const a = proc1.stdout.toString().split(" ")[0];
const b = proc2.stdout.toString().split(" ")[0];
console.log("chrome hash match:", a === b, a);
