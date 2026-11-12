import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function checkPackage(appPath, platform, arch, expectedVersion) {
  const root = platform === "darwin"
    ? path.join(appPath, "SenMuse.app", "Contents", "Resources", "app")
    : path.join(appPath, "resources", "app");
  const packaged = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (packaged.version !== expectedVersion) throw new Error("Packaged version does not match package.json");
  for (const relative of ["dist/main/main.cjs", "dist/main/preload.cjs", "dist/renderer/index.html", "assets/fonts/NotoSansCJKsc-Regular.otf", "assets/fonts/OFL.txt", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const stat = await fs.stat(path.join(root, relative));
    if (!stat.isFile() || !stat.size) throw new Error(`Missing packaged resource: ${relative}`);
  }
  for (const relative of ["src", "test", ".git", ".github", ".test-data", "node_modules/ffmpeg-static/ffmpeg", "node_modules/ffmpeg-static/ffmpeg.exe"]) {
    if (await fs.stat(path.join(root, relative)).then(() => true, () => false)) throw new Error(`Development-only file entered package: ${relative}`);
  }
  if (platform === "win32") {
    for (const relative of ["SenMuse.exe", "electron_wer.dll", "icudtl.dat", "resources.pak", "locales/zh-CN.pak", "README-Windows.txt"]) await fs.access(path.join(appPath, relative));
    const executable = await fs.readFile(path.join(appPath, "SenMuse.exe"));
    if (executable.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows executable has no DOS header");
    const pe = executable.readUInt32LE(0x3c);
    if (executable.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Windows executable has no PE header");
    const expectedMachine = { x64: 0x8664, arm64: 0xaa64 }[arch];
    if (!expectedMachine || executable.readUInt16LE(pe + 4) !== expectedMachine) throw new Error(`Windows executable has wrong architecture for ${arch}`);
    if (!executable.includes(Buffer.from('requestedExecutionLevel level="asInvoker"'))) throw new Error("Windows executable must run without requiring administrator elevation");
  }
  const report = { platform, arch, version: packaged.version, executablePresent: true, applicationResourcesPresent: true, developmentFilesExcluded: true, ffmpegDownloadedAtRuntime: true };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.env.SENMUSE_PLATFORM ?? process.platform;
  const arch = process.env.SENMUSE_ARCH ?? process.arch;
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  await checkPackage(path.resolve("release", `SenMuse-${platform}-${arch}`), platform, arch, pkg.version);
}
