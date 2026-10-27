// Runs before every `tauri build`: everything in ui/ is embedded in the app,
// so refuse to build if anything but the app's own source files is there
// (e.g. a local usage report dumped for the browser preview).
import { readdirSync } from "node:fs";

const allowed = /\.(html|js|css)$/;
const stray = readdirSync(new URL("../ui/", import.meta.url), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !allowed.test(e.name))
  .map((e) => e.name);
if (stray.length) {
  console.error(`ui/ contains files that would be bundled into the app: ${stray.join(", ")}`);
  process.exit(1);
}
