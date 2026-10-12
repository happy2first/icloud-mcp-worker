import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const client = await build({
  entryPoints: ["src/auth/credential-entry.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
await writeFile(
  "src/client.generated.ts",
  "export default " + JSON.stringify(client.outputFiles[0].text) + ";\n",
);
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
