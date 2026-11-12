import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const platform = process.env.SENMUSE_PLATFORM ?? process.platform;
const arch = process.env.SENMUSE_ARCH ?? process.arch;
if (platform !== process.platform || arch !== process.arch) throw new Error("Desktop smoke tests must run on the target OS and CPU architecture");
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const bundle = path.resolve("release", `SenMuse-${platform}-${arch}`);
const executable = platform === "darwin"
  ? path.join(bundle, "SenMuse.app", "Contents", "MacOS", "SenMuse")
  : path.join(bundle, platform === "win32" ? "SenMuse.exe" : "SenMuse");
await fs.access(executable);
const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "senmuse-package-smoke-"));
const child = spawn(executable, ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--disable-gpu", "--enable-logging=stderr"], {
  env: { ...process.env, SENMUSE_DATA_DIR: dataDirectory, ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let closed = false;
let failure;
const capture = (chunk) => { output = (output + chunk.toString()).slice(-40_000); };
child.stdout.on("data", capture);
child.stderr.on("data", capture);
child.once("error", (error) => { failure = error; closed = true; });
child.once("close", (code) => { closed = true; failure ??= new Error(`Packaged application exited with code ${code}`); });

async function inspectRenderer(url) {
  const socket = new WebSocket(url);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Renderer inspection timed out")); }, 5000);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    socket.addEventListener("error", () => finish(new Error("Renderer debugging connection failed")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate", params: {
        expression: "(async () => { if (!window.senmuse) return null; const state = await window.senmuse.invoke('state.get'); return { version: state.version, jobs: Array.isArray(state.jobs), projects: Array.isArray(state.projects), settings: !!state.settings, text: document.body.innerText }; })()",
        awaitPromise: true, returnByValue: true,
      },
    })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) finish(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else finish(null, message.result?.result?.value);
    });
  });
}

try {
  const deadline = Date.now() + 45_000;
  let verified = false;
  while (Date.now() < deadline) {
    if (closed) throw failure;
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
    if (match) {
      const debug = new URL(match[1]);
      const response = await fetch(`http://127.0.0.1:${debug.port}/json/list`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      const targets = response?.ok ? await response.json() : [];
      const renderer = targets.find((target) => target.type === "page" && target.url.startsWith("file:") && target.url.includes("/renderer/index.html"));
      if (renderer?.webSocketDebuggerUrl) {
        const result = await inspectRenderer(renderer.webSocketDebuggerUrl).catch(() => null);
        if (result?.version === pkg.version && result.jobs && result.projects && result.settings && result.text?.includes("创作")) {
          verified = true;
          console.log(JSON.stringify({ platform, arch, version: result.version, desktopStarted: true, rendererRendered: true, ipcConnected: true }));
          break;
        }
      }
    }
    await delay(250);
  }
  if (!verified) throw new Error("Packaged application did not expose a ready Chinese UI and working IPC within 45 seconds");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill();
  if (!closed) await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(5000)]);
  if (!closed) child.kill("SIGKILL");
  await delay(300);
  await fs.rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
