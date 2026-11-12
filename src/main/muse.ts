import { BrowserWindow, session, type Session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Asset, Job, MuseStatus } from "../shared/types";

const MUSE_ORIGIN = "https://muse.ai";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

export interface MusePage {
  url: string;
  composers: number;
  sendButtons: number;
  sendEnabled: boolean;
  login: boolean;
  busy: boolean;
  assistantGroups: number;
  reply: string;
  attachments: number;
  media: { url: string; kind: "image" | "video"; duration?: number }[];
  messages: {
    id: string;
    turnId: string;
    role: "user" | "assistant";
    text: string;
    media: MusePage["media"];
  }[];
}

export function generatedMedia(
  page: MusePage,
  before: MusePage,
  prompt: string,
  kind: "image" | "video",
): MusePage["media"] {
  const knownIds = new Set(before.messages.map((message) => message.id));
  const knownTurns = new Set(
    before.messages.map((message) => message.turnId).filter(Boolean),
  );
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const expected = normalize(prompt);
  const userIndex = page.messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.id &&
      !knownIds.has(message.id) &&
      (normalize(message.text) === expected ||
        normalize(message.text).endsWith(` ${expected}`)),
  );
  if (userIndex < 0) return [];
  const following = page.messages.slice(userIndex + 1);
  if (following.some((message) => message.role === "user"))
    throw new Error(
      "Muse 会话中出现了其他新消息，请先检查结果，避免把不同任务的素材混在一起。",
    );
  return following
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.id &&
        !knownIds.has(message.id) &&
        (!message.turnId || !knownTurns.has(message.turnId)),
    )
    .flatMap((message) => message.media)
    .filter(
      (media, index, all) =>
        media.kind === kind &&
        all.findIndex((other) => other.url === media.url) === index,
    );
}

export class MuseRunError extends Error {
  constructor(
    message: string,
    readonly submitted = false,
    readonly conversationUrl?: string,
  ) {
    super(message);
    this.name = "MuseRunError";
  }
}

export function normalizeProxy(value: string): string {
  const input = value.trim();
  if (!input) return "";
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `http://${input}`);
  } catch {
    throw new Error(
      "代理地址格式不正确，请填写 http://127.0.0.1:7890 或 socks5://主机:端口。",
    );
  }
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error(
      "代理只支持 HTTP、HTTPS、SOCKS5 地址，请移除用户名、密码、路径和查询参数。",
    );
  }
  // URL removes default ports. Preserve a valid default through the protocol's normal semantics.
  return `${url.protocol}//${url.host}`;
}

export function isConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === MUSE_ORIGIN &&
      /^\/thread\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) &&
      !/^\/thread\/new\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function allowedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "blob:") return url.origin === "https://muse.ai";
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return false;
    return ["muse.ai", "meta.ai", "fbcdn.net", "fbsbx.com"].some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

export function statusFromPage(page: MusePage): MuseStatus {
  if (new URL(page.url).origin !== MUSE_ORIGIN)
    return {
      state: "login_required",
      message: "请在 Muse 窗口完成登录，返回 Muse 后检查连接。",
      url: page.url,
    };
  if (page.composers === 1 && page.sendButtons === 1) {
    return {
      state: page.busy ? "busy" : "ready",
      message: page.busy
        ? "Muse 正在处理会话，请稍候。"
        : "已识别 Muse 输入框和发送按钮，可以提交任务。",
      url: page.url,
    };
  }
  if (page.login)
    return {
      state: "login_required",
      message: "请在 Muse 窗口完成登录，然后检查连接。",
      url: page.url,
    };
  return {
    state: "unknown",
    message:
      "尚未识别可用的 Muse 对话输入框。请打开一个 Muse 对话，再检查连接。",
    url: page.url,
  };
}

export function mediaExtension(
  prefix: Uint8Array,
  kind: "image" | "video",
): string | null {
  const bytes = Buffer.from(prefix);
  if (kind === "video") {
    if (bytes.subarray(4, 8).toString() === "ftyp") return "mp4";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
      return "webm";
    return null;
  }
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
  return null;
}

/** Runs only in the provider page. Keep this function self-contained for executeJavaScript. */
export function readMusePage(): MusePage {
  document
    .querySelectorAll("[data-senmuse-composer], [data-senmuse-send]")
    .forEach((element) => {
      element.removeAttribute("data-senmuse-composer");
      element.removeAttribute("data-senmuse-send");
    });
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      element.getClientRects().length > 0
    );
  };
  const text = (element: Element) =>
    `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${element.getAttribute("data-testid") ?? ""} ${element.textContent ?? ""}`.trim();
  const composers = [
    ...document.querySelectorAll<HTMLTextAreaElement | HTMLElement>(
      'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder]',
    ),
  ].filter(
    (element) =>
      visible(element) &&
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-disabled") !== "true",
  );
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ].filter(visible);
  const sendButtons = buttons.filter(
    (button) =>
      /(^|[\s_-])(send|submit)([\s_-]|$)|发送|傳送|送出|gửi/i.test(
        text(button),
      ) && !/feedback|反馈/i.test(text(button)),
  );
  // Some forms expose only a submit button. A unique composer and submit button are both required.
  const formSubmit =
    composers.length === 1
      ? [
          ...(composers[0]
            .closest("form")
            ?.querySelectorAll<HTMLButtonElement>('button[type="submit"]') ??
            []),
        ].filter(visible)
      : [];
  const sends = sendButtons.length ? sendButtons : formSubmit;
  composers.forEach((element) =>
    element.setAttribute("data-senmuse-composer", "true"),
  );
  sends.forEach((element) => element.setAttribute("data-senmuse-send", "true"));
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-message-role], [data-message-author-role], [data-role="assistant"], [data-role="user"]',
    ),
  ];
  const groups = candidates.filter(
    (element) =>
      !candidates.some((other) => other !== element && other.contains(element)),
  );
  const messages: MusePage["messages"] = [];
  for (const group of groups) {
    const role =
      group.getAttribute("data-message-role") ??
      group.getAttribute("data-message-author-role") ??
      group.getAttribute("data-role");
    if (role !== "assistant" && role !== "user") continue;
    const media: MusePage["media"] = [];
    for (const element of group.querySelectorAll<
      HTMLVideoElement | HTMLImageElement | HTMLAnchorElement
    >("video, img, a[href]")) {
      let url = "";
      let kind: "image" | "video" = "image";
      let duration: number | undefined;
      if (element instanceof HTMLVideoElement) {
        url =
          element.currentSrc ||
          element.src ||
          element.querySelector("source")?.src ||
          "";
        kind = "video";
        if (Number.isFinite(element.duration) && element.duration > 0)
          duration = element.duration;
      } else if (element instanceof HTMLImageElement) {
        if (
          element.naturalWidth < 128 ||
          element.naturalHeight < 128 ||
          /avatar|icon/i.test(element.alt)
        )
          continue;
        url = element.currentSrc || element.src;
      } else if (element instanceof HTMLAnchorElement) {
        if (!/\.(?:mp4|webm)(?:[?#]|$)/i.test(element.href)) continue;
        url = element.href;
        kind = "video";
      }
      if (url && !media.some((item) => item.url === url && item.kind === kind))
        media.push({ url, kind, ...(duration ? { duration } : {}) });
    }
    const identified =
      group.closest("[data-message-id]") ??
      group.querySelector("[data-message-id]");
    const turn =
      group.closest("[data-message-turn-id]") ??
      group.querySelector("[data-message-turn-id]");
    messages.push({
      id: identified?.getAttribute("data-message-id") ?? "",
      turnId: turn?.getAttribute("data-message-turn-id") ?? "",
      role,
      text: group.innerText ?? group.textContent ?? "",
      media,
    });
  }
  const loginInputs = [
    ...document.querySelectorAll(
      'input[type="password"], input[autocomplete="username"], input[placeholder="手机号或邮箱"]',
    ),
  ].some(visible);
  const loginButton = buttons.some((button) =>
    /^(?:log in|sign in|登录|登入)$/i.test((button.textContent ?? "").trim()),
  );
  const attachmentRoot =
    composers[0]?.closest("form") ?? composers[0]?.parentElement?.parentElement;
  const attachmentCards =
    attachmentRoot?.querySelectorAll(
      '[data-testid^="hatch-chat-attachment-presentation-"]',
    ).length ?? 0;
  const removalButtons = attachmentRoot
    ? [...attachmentRoot.querySelectorAll('button, [role="button"]')].filter(
        (element) =>
          /remove.*(?:attachment|file|image)|(?:attachment|file|image).*remove|移除|删除附件|remove attachment|remove file/i.test(
            text(element),
          ),
      ).length
    : 0;
  return {
    url: location.href,
    composers: composers.length,
    sendButtons: sends.length,
    sendEnabled:
      sends.length === 1 &&
      !sends[0].disabled &&
      sends[0].getAttribute("aria-disabled") !== "true",
    login: loginInputs || (composers.length === 0 && loginButton),
    busy:
      buttons.some(
        (button) =>
          button.getAttribute("data-testid") === "hatch-composer-stop-button" ||
          /stop (?:generating|generation|response)|停止生成|停止回答|停止回應/i.test(
            text(button),
          ),
      ) || !!document.querySelector('[aria-busy="true"]'),
    assistantGroups: messages.filter((message) => message.role === "assistant")
      .length,
    reply: messages
      .filter((message) => message.role === "assistant")
      .slice(-2)
      .map((message) => message.text)
      .join("\n")
      .slice(-8000),
    attachments: Math.max(attachmentCards, removalButtons),
    media: messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.media),
    messages,
  };
}

type RunHooks = {
  onProgress(message: string): void;
  onSubmitted(conversationUrl: string): void;
};
type GeneratedFile = { path: string; name: string; kind: "image" | "video" };

export class MuseDriver {
  private window: BrowserWindow | null = null;
  private readonly browserSession: Session;
  private running = false;
  private connecting = false;
  private status: MuseStatus = { state: "unknown", message: "尚未连接 Muse。" };

  constructor(
    private readonly options: {
      downloadDir: string;
      onStatus(status: MuseStatus): void;
    },
  ) {
    this.browserSession = session.fromPartition("persist:senmuse-provider");
    this.browserSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.on("will-download", (event) => {
      if (this.running) event.preventDefault();
    });
  }

  private publish(status: MuseStatus): MuseStatus {
    this.status = status;
    this.options.onStatus(status);
    return status;
  }

  async open(): Promise<void> {
    const window = this.ensureWindow();
    window.show();
    window.focus();
    if (!window.webContents.getURL()) await this.navigate(`${MUSE_ORIGIN}/`);
    await this.inspect();
  }

  async inspect(): Promise<MuseStatus> {
    if (this.running)
      return this.publish({
        state: "busy",
        message: "Muse 正在执行任务，状态会自动更新。",
        url: this.window?.webContents.getURL(),
      });
    if (
      !this.window ||
      this.window.isDestroyed() ||
      !this.window.webContents.getURL()
    )
      return this.publish({
        state: "unknown",
        message: "打开 Muse 窗口并登录后，检查连接。",
      });
    try {
      return this.publish(statusFromPage(await this.snapshot()));
    } catch {
      return this.publish({
        state: "error",
        message: "无法读取 Muse 页面，请等待页面加载后重试。",
        url: this.window.webContents.getURL(),
      });
    }
  }

  async setProxy(value: string): Promise<void> {
    if (this.running || this.connecting)
      throw new Error("任务运行或连接调整期间不能更改代理，请稍后再试。");
    const proxy = normalizeProxy(value);
    this.connecting = true;
    try {
      await this.browserSession.setProxy(
        proxy
          ? {
              mode: "fixed_servers",
              proxyRules: proxy,
              proxyBypassRules: "<-loopback>",
            }
          : { mode: "system" },
      );
      await this.browserSession.closeAllConnections();
      this.publish({
        state: "unknown",
        message: proxy
          ? "已设置代理，请重新检查 Muse 连接。"
          : "已切换为系统代理，请重新检查 Muse 连接。",
      });
    } finally {
      this.connecting = false;
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 1180,
      height: 840,
      minWidth: 800,
      minHeight: 600,
      show: false,
      title: "Muse · 森映",
      webPreferences: {
        session: this.browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    // The provider uses popups for account login. Each popup retains this isolated browser session.
    window.webContents.setWindowOpenHandler(({ url }) => ({
      action: /^https:\/\//i.test(url) ? "allow" : "deny",
      overrideBrowserWindowOptions: {
        webPreferences: {
          session: this.browserSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!/^https:\/\//i.test(url)) event.preventDefault();
    });
    window.on("close", (event) => {
      if (this.running) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      this.window = null;
      this.publish({
        state: "unknown",
        message: "Muse 窗口已关闭，登录状态已保存在本机。",
      });
    });
    this.window = window;
    return window;
  }

  private async navigate(url: string): Promise<void> {
    if (new URL(url).origin !== MUSE_ORIGIN)
      throw new Error("只能自动打开 Muse 官方页面。");
    await this.ensureWindow().loadURL(url);
  }

  private async snapshot(): Promise<MusePage> {
    const window = this.ensureWindow();
    if (window.webContents.isDestroyed()) throw new Error("Muse 窗口已关闭。");
    const url = window.webContents.getURL();
    if (!url || new URL(url).origin !== MUSE_ORIGIN)
      return {
        url: url || "about:blank",
        composers: 0,
        sendButtons: 0,
        sendEnabled: false,
        login: true,
        busy: false,
        assistantGroups: 0,
        reply: "",
        attachments: 0,
        media: [],
        messages: [],
      };
    const page = (await window.webContents.executeJavaScript(
      `(${readMusePage.toString()})()`,
      true,
    )) as MusePage;
    return page;
  }

  private async pause(signal: AbortSignal, duration = POLL_MS): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("任务已取消。"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, duration);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
  }

  private async ready(signal: AbortSignal): Promise<MusePage> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const page = await this.snapshot();
      const status = statusFromPage(page);
      if (status.state === "ready") return page;
      if (status.state === "login_required") throw new Error(status.message);
      await this.pause(signal);
    }
    throw new Error(
      "未能识别 Muse 输入框与发送按钮。请在 Muse 窗口打开对话并检查连接，网页改版时需要更新适配。",
    );
  }

  private async attach(
    references: Asset[],
    signal: AbortSignal,
  ): Promise<void> {
    const window = this.ensureWindow();
    const files: string[] = [];
    for (const reference of references) {
      const info = await fs.stat(reference.path);
      if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES)
        throw new Error("参考文件无法读取，或超过单文件 200 MB 上限。");
      files.push(await fs.realpath(reference.path));
    }
    if (!files.length) return;
    signal.throwIfAborted();
    const debuggerApi = window.webContents.debugger;
    if (debuggerApi.isAttached())
      throw new Error("Muse 调试器正在使用，暂时无法安全上传参考文件。");
    debuggerApi.attach("1.3");
    try {
      await debuggerApi.sendCommand("Page.enable");
      await debuggerApi.sendCommand("Page.setInterceptFileChooserDialog", {
        enabled: true,
      });
      let count = await window.webContents.executeJavaScript(
        `document.querySelectorAll('input[type="file"]').length`,
        true,
      );
      if (count === 0) {
        await window.webContents.executeJavaScript(
          `(() => {
          const buttons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0 && /attach|upload|附件|上传/i.test((button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('data-testid') || '')));
          if (buttons.length === 1) buttons[0].click();
        })()`,
          true,
        );
        await this.pause(signal, 500);
        count = await window.webContents.executeJavaScript(
          `document.querySelectorAll('input[type="file"]').length`,
          true,
        );
      }
      if (count !== 1)
        throw new Error(
          "Muse 页面没有唯一的文件上传入口，当前页面暂时无法自动上传参考素材。",
        );
      const { root } = (await debuggerApi.sendCommand("DOM.getDocument")) as {
        root: { nodeId: number };
      };
      const { nodeId } = (await debuggerApi.sendCommand("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: 'input[type="file"]',
      })) as { nodeId: number };
      await debuggerApi.sendCommand("DOM.setFileInputFiles", { nodeId, files });
    } finally {
      await debuggerApi
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
      debuggerApi.detach();
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const page = await this.snapshot();
      if (page.attachments >= files.length && !page.busy) return;
      await this.pause(signal);
    }
    throw new Error(
      "无法确认 Muse 已接收全部附件，任务尚未发送。请检查 Muse 窗口中的上传状态。",
    );
  }

  private async fill(message: string): Promise<void> {
    const result = await this.ensureWindow().webContents.executeJavaScript(
      `(() => {
      const elements = document.querySelectorAll('[data-senmuse-composer="true"]');
      if (elements.length !== 1) return false;
      const element = elements[0];
      const value = ${JSON.stringify(message)};
      if (element instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
      } else { element.textContent = value; }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return (element instanceof HTMLTextAreaElement ? element.value : element.textContent) === value;
    })()`,
      true,
    );
    if (!result) throw new Error("无法将提示词写入 Muse，请检查页面后重试。");
  }

  async run(
    job: Job,
    references: Asset[],
    hooks: RunHooks,
    signal: AbortSignal,
  ): Promise<{ files: GeneratedFile[]; conversationUrl: string }> {
    if (this.running || this.connecting)
      throw new MuseRunError("Muse 已有任务运行，请等待当前任务结束。");
    if (job.submittedAt)
      throw new MuseRunError(
        "此任务已有发送记录，请先查看 Muse 会话结果，避免重复扣除额度。",
        true,
        job.conversationUrl,
      );
    if (!job.prompt.trim()) throw new MuseRunError("请先填写生成或修改要求。");
    if (references.some((reference) => reference.kind === "audio"))
      throw new MuseRunError(
        "Muse 参考素材目前支持图片和 MP4，音频请在项目成片时添加。",
      );
    if (
      job.kind === "edit" &&
      (references.filter((reference) => reference.kind === "video").length !==
        1 ||
        references.some(
          (reference) =>
            reference.kind === "video" &&
            path.extname(reference.path).toLowerCase() !== ".mp4",
        ))
    )
      throw new MuseRunError(
        "视频修改需要一段 MP4 参考视频，可以同时添加参考图片。",
      );
    if (
      (job.kind === "image" || job.kind === "video") &&
      references.some((reference) => reference.kind !== "image")
    )
      throw new MuseRunError(
        "文生和图生任务仅接受图片参考，修改已有视频请使用视频修改。",
      );
    if (job.kind === "extend" && !isConversationUrl(job.conversationUrl ?? ""))
      throw new MuseRunError(
        "续拍需要这段视频原来的 Muse 会话。请从已完成的 Muse 视频创建续拍任务。",
      );
    this.running = true;
    let submitted = false;
    let conversationUrl = job.conversationUrl ?? "";
    const files: GeneratedFile[] = [];
    this.publish({ state: "busy", message: "正在准备 Muse 任务。" });
    try {
      signal.throwIfAborted();
      hooks.onProgress("正在打开 Muse 对话");
      await this.navigate(
        job.kind === "extend" ? conversationUrl : `${MUSE_ORIGIN}/thread/new`,
      );
      const initial = await this.ready(signal);
      if (
        job.kind === "extend" &&
        !initial.media.some((media) => media.kind === "video")
      )
        throw new Error(
          "无法在原会话中确认可续拍的视频。请先打开该会话，确认最新视频已加载。",
        );
      const sourceDuration = initial.media
        .filter((media) => media.kind === "video")
        .at(-1)?.duration;
      if (job.kind === "extend" && !sourceDuration)
        throw new Error(
          "无法读取原视频的时长，请在 Muse 中播放一次原片，再提交续拍。",
        );
      const message =
        job.kind === "image"
          ? `请生成图片并返回图片文件。创作要求：${job.prompt}`
          : job.kind === "edit"
            ? `请以附上的 MP4 为源视频，按照以下要求修改，返回修改后的 MP4 视频文件：${job.prompt}`
            : job.kind === "extend"
              ? `请继续这个会话中最新的视频，在原视频结尾之后续拍，保持人物和场景连贯，返回包含原片和续拍内容的完整 MP4。续拍要求：${job.prompt}`
              : `请生成视频并返回视频文件。${references.length ? "请以附上的图片作为参考。" : ""}创作要求：${job.prompt}`;
      await this.fill(message);
      if (job.kind !== "extend" && references.length) {
        hooks.onProgress("正在上传参考素材");
        await this.attach(references, signal);
      }
      const baseline = await this.snapshot();
      if (
        !baseline.sendEnabled ||
        baseline.composers !== 1 ||
        baseline.sendButtons !== 1
      )
        throw new Error(
          "Muse 发送按钮尚不可用，任务尚未发送。请检查附件上传和账号状态。",
        );
      signal.throwIfAborted();
      // Persist the intent before clicking. Any later failure must be reviewed, never silently sent twice.
      conversationUrl = baseline.url;
      hooks.onSubmitted(conversationUrl);
      submitted = true;
      const clicked = await this.ensureWindow().webContents.executeJavaScript(
        `(() => {
        const buttons = document.querySelectorAll('[data-senmuse-send="true"]');
        const inputs = document.querySelectorAll('[data-senmuse-composer="true"]');
        if (buttons.length !== 1 || inputs.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return false;
        const text = inputs[0] instanceof HTMLTextAreaElement ? inputs[0].value : inputs[0].textContent;
        if (text !== ${JSON.stringify(message)}) return false;
        buttons[0].click();
        return true;
      })()`,
        true,
      );
      if (!clicked)
        throw new Error(
          "未能确认发送按钮状态，请在 Muse 窗口检查此任务是否已提交。",
        );
      hooks.onProgress("已发送到 Muse，正在等待生成结果");
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let lastMedia = "";
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await this.pause(signal);
        const page = await this.snapshot();
        if (isConversationUrl(page.url) && conversationUrl !== page.url) {
          conversationUrl = page.url;
          hooks.onSubmitted(conversationUrl);
        }
        if (page.login && page.composers === 0)
          throw new Error(
            "Muse 登录状态已失效，请重新登录后检查会话中的结果。",
          );
        const kind = job.kind === "image" ? "image" : "video";
        const fresh = generatedMedia(page, baseline, message, kind).filter(
          (media) =>
            job.kind !== "extend" ||
            (media.duration !== undefined &&
              media.duration > sourceDuration! + 0.1),
        );
        const signature = JSON.stringify(fresh);
        if (signature !== lastMedia || page.busy) {
          lastMedia = signature;
          stableSince = Date.now();
        }
        if (!fresh.length || page.busy || Date.now() - stableSince < 12_000)
          continue;
        if (!isConversationUrl(conversationUrl))
          throw new Error(
            "Muse 已显示素材，但无法确认对应会话地址，请手动检查后保存。",
          );
        if (fresh.length > 4)
          throw new Error(
            "Muse 返回超过 4 个素材，请在会话中确认需要保存的结果。",
          );
        hooks.onProgress("正在保存 Muse 生成的素材");
        const fingerprints = new Set<string>();
        if (job.kind === "extend")
          for (const reference of references)
            fingerprints.add(await fileDigest(reference.path));
        for (const media of fresh) {
          const file = await this.download(media, signal);
          files.push(file);
          const digest = await fileDigest(file.path);
          if (fingerprints.has(digest)) {
            await fs.unlink(file.path);
            files.pop();
          } else fingerprints.add(digest);
        }
        if (!files.length)
          throw new Error(
            "Muse 返回的内容与已有视频相同，尚未确认成功续拍，请检查原会话。",
          );
        return { files, conversationUrl };
      }
      throw new Error(
        "等待 Muse 结果超过 25 分钟。请打开会话确认生成状态，本任务不会自动再次发送。",
      );
    } catch (error) {
      for (const file of files)
        await fs.unlink(file.path).catch(() => undefined);
      throw new MuseRunError(
        signal.aborted
          ? "任务已取消。已发送的请求可能仍在 Muse 中运行，请查看原会话。"
          : error instanceof Error
            ? error.message
            : "Muse 任务未完成，请检查页面。",
        submitted,
        conversationUrl || undefined,
      );
    } finally {
      this.running = false;
      await this.inspect();
    }
  }

  private async download(
    media: MusePage["media"][number],
    signal: AbortSignal,
  ): Promise<GeneratedFile> {
    if (!allowedMediaUrl(media.url))
      throw new Error(
        "Muse 返回的下载地址尚未适配，已停止自动下载，请在 Muse 会话中保存该素材。",
      );
    const token = `__senmuse_${randomUUID().replaceAll("-", "")}`;
    const window = this.ensureWindow();
    const allowed = allowedMediaUrl.toString();
    const pendingPath = path.join(
      this.options.downloadDir,
      `${randomUUID()}.part`,
    );
    await fs.mkdir(this.options.downloadDir, { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const cancel = () => {
      if (!window.webContents.isDestroyed())
        void window.webContents
          .executeJavaScript(
            `globalThis[${JSON.stringify(token)}]?.controller.abort()`,
          )
          .catch(() => undefined);
    };
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await window.webContents.executeJavaScript(
        `(async () => {
        const allowedMediaUrl = ${allowed};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        globalThis[${JSON.stringify(token)}] = { controller, timer, reader: null, bytes: 0, pending: null };
        const response = await fetch(${JSON.stringify(media.url)}, { credentials: 'include', signal: controller.signal, redirect: 'error' });
        if (!response.ok || !response.body || !allowedMediaUrl(response.url)) throw new Error('下载响应无效');
        const size = Number(response.headers.get('content-length') || 0);
        if (size > ${MAX_DOWNLOAD_BYTES}) throw new Error('素材超过200MB');
        globalThis[${JSON.stringify(token)}].reader = response.body.getReader();
      })()`,
        true,
      );
      handle = await fs.open(pendingPath, "wx");
      let prefix = Buffer.alloc(0);
      let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = (await window.webContents.executeJavaScript(
          `(async () => {
          const task = globalThis[${JSON.stringify(token)}];
          let data = task.pending;
          if (!data) {
            const chunk = await task.reader.read();
            if (chunk.done) return { done: true, data: [] };
            data = chunk.value;
            task.bytes += data.byteLength;
            if (task.bytes > ${MAX_DOWNLOAD_BYTES}) { task.controller.abort(); throw new Error('素材超过200MB'); }
          }
          task.pending = data.length > 65536 ? data.subarray(65536) : null;
          return { done: false, data: Array.from(data.subarray(0, 65536)) };
        })()`,
          true,
        )) as { done: boolean; data: number[] };
        if (chunk.done) break;
        const buffer = Buffer.from(chunk.data);
        bytes += buffer.length;
        if (bytes > MAX_DOWNLOAD_BYTES)
          throw new Error("生成素材超过单文件 200 MB 下载上限。");
        if (prefix.length < 64)
          prefix = Buffer.concat([prefix, buffer]).subarray(0, 64);
        await handle.writeFile(buffer);
      }
      const extension = mediaExtension(prefix, media.kind);
      if (!extension || !bytes)
        throw new Error(
          "下载内容未通过图片或视频格式检查，请在 Muse 会话中确认文件。",
        );
      await handle.close();
      handle = undefined;
      const name = `${media.kind === "video" ? "Muse视频" : "Muse图片"}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${extension}`;
      const finalPath = path.join(this.options.downloadDir, name);
      await fs.rename(pendingPath, finalPath);
      return { path: finalPath, name, kind: media.kind };
    } finally {
      signal.removeEventListener("abort", cancel);
      await handle?.close().catch(() => undefined);
      await fs.unlink(pendingPath).catch(() => undefined);
      if (!window.webContents.isDestroyed())
        await window.webContents
          .executeJavaScript(
            `(() => { const task = globalThis[${JSON.stringify(token)}]; if (task) { task.controller.abort(); clearTimeout(task.timer); delete globalThis[${JSON.stringify(token)}]; } })()`,
          )
          .catch(() => undefined);
    }
  }
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
