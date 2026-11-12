import { packager } from "@electron/packager";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { checkPackage } from "./package-check.mjs";

const platform = process.env.SENMUSE_PLATFORM ?? process.platform;
const arch = process.env.SENMUSE_ARCH ?? process.arch;
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const releaseVersion = (process.env.SENMUSE_RELEASE_VERSION || pkg.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) throw new Error("Invalid release version");
if (releaseVersion.split("-")[0] !== pkg.version.split("-")[0]) throw new Error("Release version must match package.json");
if (!["win32", "darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported packaging platform or architecture");
if (platform === "win32" && arch !== "x64") throw new Error("Windows packages currently support x64");
if (platform === "darwin" && process.platform !== "darwin") throw new Error("macOS signing and packaging must run on macOS");
await fs.access("dist/main/main.cjs");
await fs.access("dist/renderer/index.html");

const apps = await packager({
  dir: ".",
  name: "SenMuse",
  platform,
  arch,
  out: "release",
  overwrite: true,
  appBundleId: "io.github.zysen1.senmuse",
  appVersion: pkg.version,
  buildVersion: pkg.version.split("-")[0],
  appCopyright: "Copyright © 2026 zysen1",
  win32metadata: {
    CompanyName: "SenMuse contributors",
    FileDescription: "SenMuse · 森映创作工作台",
    ProductName: "SenMuse",
    "requested-execution-level": "asInvoker",
  },
  asar: false,
  prune: true,
  ignore: [
    /^\/src($|\/)/,
    /^\/api($|\/)/,
    /^\/examples($|\/)/,
    /^\/\.senmuse-api($|\/)/,
    /^\/\.muse-probe($|\/)/,
    /^\/test($|\/)/,
    /^\/release($|\/)/,
    /^\/\.git($|\/)/,
    /^\/\.github($|\/)/,
    /^\/\.test-data($|\/)/,
    /^\/vendor($|\/)/,
    /^\/coverage($|\/)/,
    /^\/\.env(?:\.|$)/,
    /^\/(?:\.npmrc|\.DS_Store|AGENTS\.md)$/,
    /node_modules\/\.(?:vite|cache)(?:\/|$)/,
    /node_modules\/ffmpeg-static\/ffmpeg(?:\.exe)?$/,
    /^\/scripts\/(?!mcp\.mjs$)/,
  ],
});

async function archiveDirectory(source, archive) {
  if (process.platform === "darwin") {
    const flags = platform === "darwin" ? ["--sequesterRsrc"] : ["--norsrc", "--noextattr"];
    execFileSync("ditto", ["-c", "-k", ...flags, "--keepParent", source, archive], { stdio: "inherit" });
  } else if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:SENMUSE_ARCHIVE_SOURCE -DestinationPath $env:SENMUSE_ARCHIVE_DESTINATION -CompressionLevel Optimal -Force"], {
      stdio: "inherit",
      env: { ...process.env, SENMUSE_ARCHIVE_SOURCE: source, SENMUSE_ARCHIVE_DESTINATION: archive },
    });
  } else {
    execFileSync("zip", ["-q", "-r", "-y", archive, path.basename(source)], { cwd: path.dirname(source), stdio: "inherit" });
  }
}

for (const appPath of apps) {
  let source = appPath;
  if (platform === "darwin") {
    const bundle = path.join(appPath, "SenMuse.app");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], {
      stdio: "inherit",
    });
    source = bundle;
  }
  if (platform === "win32") {
    await fs.writeFile(path.join(appPath, "README-Windows.txt"), "\uFEFF森映 SenMuse\r\n\r\n1. 请先完整解压这个文件夹，再双击 SenMuse.exe。\r\n2. 应用无需管理员权限，也不需要安装 Node.js。\r\n3. 在应用内登录自己的 Muse 账号，即可开始创作。\r\n4. 首次导出会自动下载视频合成工具，请保持网络连接。\r\n5. 登录信息、项目与设置保存在 %APPDATA%\\SenMuse，升级时可以替换整个应用文件夹。\r\n\r\n源码与问题反馈：https://github.com/zysen1/senmuse\r\n", "utf8");
  }
  await checkPackage(appPath, platform, arch, pkg.version);
  const platformName = { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform];
  const portable = platform === "win32" ? "-portable" : "";
  const archive = path.resolve("release", `SenMuse-${releaseVersion}-${platformName}-${arch}${portable}.zip`);
  const temporary = archive.replace(/\.zip$/, ".partial.zip");
  await fs.rm(temporary, { force: true });
  try {
    await archiveDirectory(source, temporary);
    await fs.rename(temporary, archive);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    await fs.writeFile(`${archive}.sha256`, `${hash.digest("hex")}  ${path.basename(archive)}\n`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(archive);
}
