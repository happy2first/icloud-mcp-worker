import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const admin = await build({
  entryPoints: ["src/app/admin-entry.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
await writeFile(
  "src/admin.generated.ts",
  "export default " + JSON.stringify(admin.outputFiles[0].text) + ";\n",
);
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
  define: {
    __D1_SCHEMA_SQL__: JSON.stringify(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    ),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
