import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { MuseProviderConfig } from "../types.ts";

const requireApi = createRequire(
  new URL("../../../api/package.json", import.meta.url),
);
const ORIGIN = "https://muse.ai";

// Dependencies are confined to the optional API installation, not the desktop app.
export function apiDependency(name: "playwright" | "undici"): any {
  try {
    return requireApi(name);
  } catch {
    throw new MuseAuthError(
      "unconfigured",
      "请先在 api 目录运行 npm ci，安装 Muse API 运行依赖。",
    );
  }
}

export class MuseAuthError extends Error {
  state: "login_required" | "unconfigured" | "error";
  constructor(state: MuseAuthError["state"], message: string) {
    super(message);
    this.name = "MuseAuthError";
    this.state = state;
  }
}

export interface GatewayCredentials {
  vmId: string;
  token: string;
  notaryToken?: string;
}

export function checkedProxy(value?: string): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MuseAuthError("unconfigured", "代理地址无效。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new MuseAuthError(
      "unconfigured",
      "Muse API 目前支持无用户名密码的 HTTP/HTTPS 代理；暂不支持 SOCKS 代理。",
    );
  }
  return url.origin;
}

export function checkedCdp(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MuseAuthError("unconfigured", "CDP 地址无效。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    !(
      ["https:", "wss:"].includes(url.protocol) ||
      (local && ["http:", "ws:"].includes(url.protocol))
    )
  ) {
    throw new MuseAuthError(
      "unconfigured",
      "CDP 只接受本机地址或明确配置的 HTTPS/WSS 连接。",
    );
  }
  return url.href;
}

interface Page {
  goto(url: string, options?: object): Promise<unknown>;
  url(): string;
  evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: any): Promise<T>;
  close(): Promise<void>;
  isClosed(): boolean;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  contexts(): Context[];
  close(): Promise<void>;
}

export class MuseBrowserAuth {
  private config: MuseProviderConfig;
  private context?: Context;
  private browser?: Browser;
  private page?: Page;
  private opening?: Promise<Page>;
  private closed = false;
  constructor(config: MuseProviderConfig) {
    this.config = config;
  }

  async open(login = false): Promise<Page> {
    if (this.closed)
      throw new MuseAuthError("error", "Muse 浏览器连接已关闭。");
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.opening) return this.opening;
    this.opening = this.openOnce(login).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openOnce(login: boolean): Promise<Page> {
    const proxy = checkedProxy(this.config.proxy);
    const { chromium } = apiDependency("playwright");
    try {
      if (this.config.cdpUrl) {
        this.browser = await chromium.connectOverCDP(
          checkedCdp(this.config.cdpUrl),
          { timeout: 30_000 },
        );
        this.context = this.browser!.contexts()[0];
        if (!this.context)
          throw new MuseAuthError(
            "unconfigured",
            "CDP 浏览器没有可用的已登录上下文。",
          );
      } else {
        if (!this.config.profileDir)
          throw new MuseAuthError(
            "unconfigured",
            "请配置独立的 Muse 浏览器 profileDir。",
          );
        const profile = path.resolve(this.config.profileDir);
        await fs.mkdir(profile, { recursive: true, mode: 0o700 });
        this.context = await chromium.launchPersistentContext(profile, {
          headless: login ? false : this.config.headless !== false,
          ...(proxy ? { proxy: { server: proxy } } : {}),
          acceptDownloads: false,
          timeout: 30_000,
        });
      }
      if (this.closed)
        throw new MuseAuthError("error", "Muse 浏览器连接已关闭。");
      this.page = await this.context!.newPage();
      if (this.closed)
        throw new MuseAuthError("error", "Muse 浏览器连接已关闭。");
      await this.page.goto(login ? ORIGIN : `${ORIGIN}/robots.txt`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (this.closed)
        throw new MuseAuthError("error", "Muse 浏览器连接已关闭。");
      return this.page;
    } catch (error) {
      await this.dispose();
      if (error instanceof MuseAuthError) throw error;
      throw new MuseAuthError(
        "error",
        login
          ? "无法打开登录浏览器。Linux 首次登录需要图形会话，或配置已登录浏览器的 CDP 地址。"
          : "无法打开 Muse 浏览器。请检查 Chromium 安装、独立配置目录、CDP 地址与网络。",
      );
    }
  }

  private async request(
    route: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ status: number; data: Record<string, any> }> {
    signal.throwIfAborted();
    const page = await this.open();
    if (new URL(page.url()).origin !== ORIGIN)
      throw new MuseAuthError("login_required", "请完成 Muse 登录后重新连接。");
    try {
      const result = await page.evaluate(
        async ({ route, body }) => {
          const response = await fetch(route, {
            method: body === undefined ? "GET" : "POST",
            credentials: "include",
            redirect: "error",
            headers: {
              "x-app-id": "hatch-web",
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(20_000),
          });
          const text = await response.text();
          if (text.length > 1024 * 1024)
            throw new Error("Unexpected bootstrap response size");
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            data = {};
          }
          return {
            status: response.status,
            data:
              data && typeof data === "object" && !Array.isArray(data)
                ? (data as Record<string, any>)
                : {},
          };
        },
        { route, body },
      );
      signal.throwIfAborted();
      if ([401, 403].includes(result.status))
        throw new MuseAuthError(
          "login_required",
          "Muse 登录已失效或需要人工验证，请重新登录。",
        );
      if (result.status === 429)
        throw new MuseAuthError("error", "Muse 请求受到限流，请稍后再试。");
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof MuseAuthError) throw error;
      throw new MuseAuthError(
        "error",
        "Muse 登录会话请求失败，请检查浏览器与网络。",
      );
    }
  }

  async hasSession(signal: AbortSignal): Promise<boolean> {
    const response = await this.request(
      "/api/session?vm_state=live",
      undefined,
      signal,
    );
    return (
      response.status === 200 &&
      typeof (response.data.endpoint_url ?? response.data.endpointUrl) ===
        "string"
    );
  }

  async credentials(signal: AbortSignal): Promise<GatewayCredentials> {
    let response = await this.request(
      "/api/session?vm_state=live",
      undefined,
      signal,
    );
    if (response.status !== 200)
      throw new MuseAuthError("login_required", "未取得有效的 Muse 登录会话。");
    let info = response.data;
    const target = () => {
      const endpoint = info.endpoint_url ?? info.endpointUrl;
      let vm: URL;
      try {
        vm = new URL(endpoint);
      } catch {
        throw new MuseAuthError(
          "login_required",
          "Muse 尚未为当前账号分配运行环境。",
        );
      }
      if (
        vm.protocol !== "https:" ||
        !vm.hostname.endsWith(".metaaivm.com") ||
        vm.username ||
        vm.password
      )
        throw new MuseAuthError("error", "Muse 返回了尚未适配的运行环境地址。");
      const vmId = String(info.vm_id ?? info.vmId ?? vm.hostname.split(".")[0]);
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(vmId))
        throw new MuseAuthError("error", "Muse 运行环境标识无效。");
      return { endpoint, vmId };
    };
    let { endpoint, vmId } = target();
    const running = () =>
      !info.vm_state || /^(running|ready|live)$/i.test(String(info.vm_state));
    if (!running()) {
      const deadline = Date.now() + 90_000;
      let attempts = 0;
      while (!running() && Date.now() < deadline) {
        if (attempts % 5 === 0)
          await this.request(
            "/api/hatch/vm/wake",
            { vm_id: vmId, retry_count: Math.floor(attempts / 5) },
            signal,
          );
        await delay(2000, undefined, { signal });
        response = await this.request(
          "/api/session?vm_state=live",
          undefined,
          signal,
        );
        if (response.status === 200) info = response.data;
        attempts++;
      }
      if (!running())
        throw new MuseAuthError("error", "Muse 运行环境未能在 90 秒内启动。");
    }
    // Waking can allocate a different VM; credentials must refer to its latest address.
    ({ endpoint, vmId } = target());
    const tokenReply = await this.request(
      "/api/hatch/token",
      { vmAddress: endpoint, vmName: vmId },
      signal,
    );
    if (
      tokenReply.status !== 200 ||
      typeof tokenReply.data.token !== "string" ||
      !tokenReply.data.token
    ) {
      throw new MuseAuthError(
        "login_required",
        "Muse 未签发网关连接凭据，请检查登录或账号状态。",
      );
    }
    let notaryToken =
      typeof tokenReply.data.notary_token === "string"
        ? tokenReply.data.notary_token
        : undefined;
    const notaryReply = await this.request(
      "/api/hatch/noise-notary-token",
      { vmName: vmId },
      signal,
    );
    if (
      notaryReply.status === 200 &&
      typeof notaryReply.data.notaryToken === "string"
    )
      notaryToken = notaryReply.data.notaryToken;
    else if (![200, 404].includes(notaryReply.status))
      throw new MuseAuthError("error", "Muse 网关认证服务暂不可用。");
    return {
      vmId,
      token: tokenReply.data.token,
      ...(notaryToken ? { notaryToken } : {}),
    };
  }

  private async dispose(): Promise<void> {
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    await page?.close().catch(() => undefined);
    // Playwright disconnects CDP connections; never send Browser.close via CDP.
    if (browser) await browser.close().catch(() => undefined);
    else await context?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    const opening = this.opening;
    await this.dispose();
    await opening?.catch(() => undefined);
    await this.dispose();
  }
}

export async function loginMuse(config: MuseProviderConfig): Promise<void> {
  const auth = new MuseBrowserAuth(config);
  const signal = AbortSignal.timeout(10 * 60_000);
  try {
    await auth.open(true);
    while (!signal.aborted) {
      try {
        if (await auth.hasSession(signal)) return;
      } catch (error) {
        if (
          !(error instanceof MuseAuthError) ||
          error.state !== "login_required"
        )
          throw error;
      }
      await delay(2000, undefined, { signal });
    }
    throw new MuseAuthError(
      "login_required",
      "登录等待超时，请重新运行登录命令。",
    );
  } finally {
    await auth.close();
  }
}
