import { build } from "esbuild";
import { build as viteBuild } from "vite";
import fs from "node:fs/promises";
await fs.mkdir("dist/main", { recursive: true });
await build({
  entryPoints: ["src/main/main.ts", "src/main/preload.ts"],
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "ffmpeg-static"],
});
await viteBuild();
