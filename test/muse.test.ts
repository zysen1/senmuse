import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {} }));

import {
  allowedMediaUrl,
  generatedMedia,
  isConversationUrl,
  mediaExtension,
  MuseRunError,
  normalizeProxy,
  statusFromPage,
  type MusePage,
} from "../src/main/muse";

const page: MusePage = {
  url: "https://muse.ai/thread/test-123",
  composers: 1,
  sendButtons: 1,
  sendEnabled: false,
  login: false,
  busy: false,
  assistantGroups: 0,
  reply: "",
  attachments: 0,
  media: [],
  messages: [],
};

describe("Muse connection status", () => {
  it("requires a single recognized composer and send button", () => {
    expect(statusFromPage(page).state).toBe("ready");
    expect(statusFromPage({ ...page, composers: 0 }).state).toBe("unknown");
    expect(statusFromPage({ ...page, composers: 2 }).state).toBe("unknown");
    expect(statusFromPage({ ...page, sendButtons: 0 }).state).toBe("unknown");
    expect(statusFromPage({ ...page, busy: true }).state).toBe("busy");
  });

  it("treats the real login-page shape as logged out", () => {
    expect(
      statusFromPage({
        ...page,
        url: "https://muse.ai/?aymh_complete=1",
        composers: 0,
        sendButtons: 0,
        login: true,
      }).state,
    ).toBe("login_required");
    expect(
      statusFromPage({ ...page, url: "https://accounts.google.com/" }).state,
    ).toBe("login_required");
  });
});

describe("Muse destinations and proxy validation", () => {
  it("requires an existing official conversation for continuation", () => {
    expect(isConversationUrl(page.url)).toBe(true);
    for (const value of [
      "https://muse.ai/thread/new",
      "https://muse.ai.evil.test/thread/123",
      "http://muse.ai/thread/123",
      "https://user:pass@muse.ai/thread/123",
      "file:///thread/123",
    ]) {
      expect(isConversationUrl(value), value).toBe(false);
    }
  });

  it("only downloads provider blobs and approved HTTPS media hosts", () => {
    expect(allowedMediaUrl("blob:https://muse.ai/123")).toBe(true);
    expect(
      allowedMediaUrl("https://video.xx.fbcdn.net/output.mp4?signature=abc"),
    ).toBe(true);
    for (const value of [
      "http://muse.ai/a.mp4",
      "file:///etc/passwd",
      "https://127.0.0.1/a.mp4",
      "https://169.254.169.254/latest",
      "https://muse.ai:8443/a.mp4",
      "https://muse.ai.evil.test/a.mp4",
      "https://user:pass@muse.ai/a.mp4",
      "blob:https://evil.test/123",
      "data:video/mp4;base64,aaaa",
    ]) {
      expect(allowedMediaUrl(value), value).toBe(false);
    }
  });

  it("keeps the browser-side download validator self-contained", () => {
    const browserValidator = new Function(
      `return (${allowedMediaUrl.toString()})`,
    )() as typeof allowedMediaUrl;
    expect(browserValidator("blob:https://muse.ai/123")).toBe(true);
    expect(browserValidator("https://localhost/secret")).toBe(false);
  });

  it("accepts system proxy or explicit supported addresses", () => {
    expect(normalizeProxy("")).toBe("");
    expect(normalizeProxy("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxy("socks5://127.0.0.1:1080")).toBe(
      "socks5://127.0.0.1:1080",
    );
    for (const proxy of [
      "file:///tmp/proxy",
      "http://user:pass@host:8080",
      "https://host:8080/path",
      "http://host:8080?proxy=x",
      "socks4://host:1080",
      "http://host:99999",
    ]) {
      expect(() => normalizeProxy(proxy), proxy).toThrow();
    }
  });
});

describe("Muse generated files and submission state", () => {
  it("binds outputs to the accepted new user message, ignoring old messages with refreshed blob URLs", () => {
    const baseline: MusePage = {
      ...page,
      messages: [
        {
          id: "old-user",
          turnId: "old-turn",
          role: "user",
          text: "old prompt",
          media: [],
        },
        {
          id: "old-answer",
          turnId: "old-turn",
          role: "assistant",
          text: "",
          media: [{ url: "blob:https://muse.ai/old", kind: "video" }],
        },
      ],
    };
    const refreshed: MusePage = {
      ...page,
      messages: [
        baseline.messages[0],
        {
          ...baseline.messages[1],
          media: [{ url: "blob:https://muse.ai/refreshed", kind: "video" }],
        },
      ],
    };
    expect(generatedMedia(refreshed, baseline, "new prompt", "video")).toEqual(
      [],
    );
    const result: MusePage = {
      ...refreshed,
      messages: [
        ...refreshed.messages,
        {
          id: "new-user",
          turnId: "new-turn",
          role: "user",
          text: "new prompt",
          media: [],
        },
        {
          id: "new-answer",
          turnId: "new-turn",
          role: "assistant",
          text: "",
          media: [{ url: "blob:https://muse.ai/result", kind: "video" }],
        },
      ],
    };
    expect(generatedMedia(result, baseline, "new prompt", "video")).toEqual([
      { url: "blob:https://muse.ai/result", kind: "video" },
    ]);
    result.messages.push({
      id: "someone-else",
      turnId: "third-turn",
      role: "user",
      text: "unrelated",
      media: [],
    });
    expect(() =>
      generatedMedia(result, baseline, "new prompt", "video"),
    ).toThrow("其他新消息");
  });

  it("rejects a server error disguised as a media filename", () => {
    expect(
      mediaExtension(Buffer.from("<html>Forbidden</html>"), "video"),
    ).toBeNull();
    expect(
      mediaExtension(Buffer.from("<html>Forbidden</html>"), "image"),
    ).toBeNull();
    expect(
      mediaExtension(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]), "video"),
    ).toBe("mp4");
    expect(
      mediaExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image"),
    ).toBe("png");
  });

  it("preserves an uncertain send for queue reconciliation", () => {
    const error = new MuseRunError("读取页面失败", true, page.url);
    expect(error.submitted).toBe(true);
    expect(error.conversationUrl).toBe(page.url);
    expect(new MuseRunError("尚未登录").submitted).toBe(false);
  });
});
