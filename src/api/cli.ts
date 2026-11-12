import fs from "node:fs";
import path from "node:path";
import {
  dataDirectory,
  initConfig,
  readConfig,
  readToken,
  lockData,
} from "./config.ts";
import { ApiEngine } from "./engine.ts";
import { ApiServer } from "./server.ts";
import { NativeCommandProvider } from "./native.ts";
import { safeMessage } from "./validation.ts";
import type { ApiConfig, GenerationProvider } from "./types.ts";
async function providerFor(config: ApiConfig): Promise<GenerationProvider> {
  if (config.provider.type === "command")
    return new NativeCommandProvider(config.provider);
  const { MuseGatewayProvider } = await import("./muse/provider.ts");
  return new MuseGatewayProvider(config.provider);
}
export async function main(argv: string[]): Promise<void> {
  let unlock: (() => void) | undefined;
  try {
    const command = argv[0] ?? "help";
    let directory: string | undefined;
    let native =
      fs.existsSync("/opt/hatch/bin/media-generation") ||
      fs.existsSync("/opt/muse/bin/media-generation");
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--data" && argv[i + 1]) directory = argv[++i];
      else if (argv[i] === "--native") native = true;
      else throw new Error(`无法识别参数：${argv[i]}`);
    }
    const dir = dataDirectory(directory);
    const out = (value: unknown) =>
      process.stdout.write(JSON.stringify(value) + "\n");
    if (command === "help" || command === "--help") {
      console.log(
        "森映 Muse API\n\nnode scripts/senmuse-api.mjs init [--native] [--data DIR]\nnode scripts/senmuse-api.mjs login [--data DIR]\nnode scripts/senmuse-api.mjs doctor [--data DIR]\nnode scripts/senmuse-api.mjs serve [--data DIR]\nnode scripts/senmuse-api.mjs token [--data DIR]\n\nMuse 云主机先运行 node scripts/probe-muse.mjs；配置原生生成组件后使用 --native 路线。外部电脑使用登录会话与 Muse 直连。",
      );
      return;
    }
    if (command === "init") {
      const config = initConfig(dir, native);
      out({
        ok: true,
        config: path.join(dir, "config.json"),
        tokenFile: config.tokenFile,
        next: native
          ? "已配置自动原生适配器；运行 doctor 检查当前主机组件，参阅 docs/MUSE_API.md"
          : "安装 api 依赖和 Chromium 后运行 login",
      });
      return;
    }
    const config = readConfig(dir);
    if (command === "token") {
      console.log(readToken(config));
      return;
    }
    if (!["login", "doctor", "serve"].includes(command))
      throw new Error("未知命令；使用 --help 查看用法");
    unlock = lockData(dir);
    if (command === "login") {
      if (config.provider.type !== "muse")
        throw new Error("原生组件模式不需要浏览器登录");
      const { loginMuse } = await import("./muse/auth.ts");
      await loginMuse(config.provider);
      out({ ok: true, message: "Muse 登录会话已检查" });
      return;
    }
    const provider = await providerFor(config);
    if (command === "doctor") {
      try {
        const status = await provider.status();
        out({
          ok: status.state === "ready",
          provider: config.provider.type,
          ...status,
        });
        if (status.state !== "ready") process.exitCode = 1;
      } finally {
        await provider.close();
      }
      return;
    }
    const engine = new ApiEngine(dir, provider);
    const server = new ApiServer(config, readToken(config), engine);
    try {
      await server.listen();
    } catch (error) {
      await engine.close();
      throw error;
    }
    out({
      ok: true,
      service: "senmuse-api",
      url: server.baseUrl,
      mcp: `${server.baseUrl}/mcp`,
      tokenFile: config.tokenFile,
      provider: config.provider.type,
    });
    // Do not log tokens or browser credentials. The process remains attached to the supervisor.
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void server.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: safeMessage(error) }));
    process.exitCode = 1;
  } finally {
    unlock?.();
  }
}
