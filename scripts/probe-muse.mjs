#!/usr/bin/env node
// Read-only discovery. It never generates media, starts a proxy, or reads credentials.
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.some((arg) => !["--json", "--help"].includes(arg))) {
  console.error("用法：node scripts/probe-muse.mjs [--json]");
  process.exitCode = 2;
} else if (args.includes("--help")) {
  console.log(
    "只读检查 Muse 云端已安装组件，输出 JSON。只调用固定组件的 --help，不生成素材、不读取凭据、不启动网络服务。",
  );
} else {
  const components = [
    {
      name: "media-generation",
      file: "/opt/hatch/bin/media-generation",
      help: true,
    },
    {
      name: "muse-media-generation",
      file: "/opt/muse/bin/media-generation",
      help: true,
    },
    {
      name: "ingress-rev-proxy",
      file: "/opt/hatch/bin/ingress-rev-proxy",
      help: true,
    },
    {
      name: "hatch-ws-client",
      file: "/opt/hatch/bin/hatch-ws-client",
      help: true,
    },
    {
      name: "space-sdk",
      file: "/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz",
      help: false,
    },
    {
      name: "space-runtime-docs",
      file: "/opt/hatch/skills/spaces/ts-runtime/README.md",
      help: false,
    },
    {
      name: "muse-space-sdk",
      file: "/opt/muse/assets/spaces/ts-runtime/dist/space-sdk.tgz",
      help: false,
    },
    {
      name: "muse-space-runtime-docs",
      file: "/opt/muse/assets/spaces/ts-runtime/README.md",
      help: false,
    },
    {
      name: "media-docs",
      file: path.join(os.homedir(), "docs/media.md"),
      help: false,
    },
    {
      name: "artifact-docs",
      file: path.join(os.homedir(), "docs/artifacts.md"),
      help: false,
    },
  ];
  const results = [];
  for (const component of components) {
    const result = {
      name: component.name,
      path: component.file,
      present: false,
    };
    try {
      const info = await lstat(component.file);
      result.present = true;
      result.kind = info.isSymbolicLink()
        ? "symlink"
        : info.isFile()
          ? "file"
          : "other";
      result.sizeBytes = info.size;
      if (component.help) {
        try {
          await access(component.file, constants.X_OK);
          result.executable = true;
        } catch {
          result.executable = false;
        }
        if (result.executable) result.help = await help(component.file);
      }
    } catch (error) {
      result.error =
        error.code === "ENOENT" ? "not_installed" : error.code || "unreadable";
    }
    results.push(result);
  }
  console.log(
    JSON.stringify(
      {
        version: 1,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        purpose: "read_only_discovery",
        generationAttempted: false,
        accountAvailability: "unknown",
        quota: "unknown",
        publicIngress: "unverified",
        components: results,
        next: "请按当前主机的实际 --help 和 SDK 文档编写适配器。文件存在不代表媒体生成、账号额度或公开入口可用。",
      },
      null,
      2,
    ),
  );
}

function help(file) {
  return new Promise((resolve) => {
    const child = spawn(file, ["--help"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;
    let forced;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 5_000);
    const append = (chunk) => {
      if (truncated) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 48_000) {
        output = output.slice(0, 24_000);
        truncated = true;
        stop();
      }
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forced);
      resolve(value);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) =>
      done({ error: error.code || "spawn_failed" }),
    );
    child.once("close", (code, signal) =>
      done({
        exitCode: code,
        signal,
        timedOut,
        truncated,
        text: redact(output),
      }),
    );
  });
}

function redact(text) {
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(
      /((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s"']+/gi,
      "$1[redacted]",
    );
}
