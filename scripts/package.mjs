import { packager } from "@electron/packager";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const platform = process.env.SENMUSE_PLATFORM ?? process.platform;
const arch = process.env.SENMUSE_ARCH ?? process.arch;
const apps = await packager({
  dir: ".",
  name: "SenMuse",
  platform,
  arch,
  out: "release",
  overwrite: true,
  appBundleId: "io.github.zysen1.senmuse",
  appCopyright: "Copyright © 2026 zysen1",
  asar: false,
  prune: true,
  ignore: [
    /^\/src($|\/)/,
    /^\/test($|\/)/,
    /^\/release($|\/)/,
    /^\/\.git($|\/)/,
    /^\/\.test-data($|\/)/,
    /^\/vendor($|\/)/,
    /node_modules\/ffmpeg-static\/ffmpeg(?:\.exe)?$/,
    /^\/scripts\/dev\.mjs$/,
  ],
});
for (const appPath of apps) {
  if (platform === "darwin") {
    const bundle = path.join(appPath, "SenMuse.app");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], {
      stdio: "inherit",
    });
    const zip = path.resolve("release", `SenMuse-0.1.0-macOS-${arch}.zip`);
    await fs.rm(zip, { force: true });
    execFileSync(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, zip],
      { stdio: "inherit" },
    );
    console.log(zip);
  } else console.log(appPath);
}
