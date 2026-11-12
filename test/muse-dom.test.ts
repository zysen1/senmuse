import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {} }));
import { readMusePage, type MusePage } from "../src/main/muse";

it("reads provider DOM attributes in an isolated Chromium fixture", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "senmuse-dom-"));
  const fixture = `<!doctype html><html><body>
    <article data-message-role="user" data-message-id="u1" data-message-turn-id="turn1"><p>Generate video</p></article>
    <article data-message-role="assistant" data-message-id="a1" data-message-turn-id="turn1">
      <div data-testid="hatch-chat-attachment-presentation-video"><video src="blob:https://muse.ai/fixture"></video></div>
    </article>
    <form><textarea></textarea><button aria-label="Send message">Send</button>
      <div data-testid="hatch-chat-attachment-presentation-upload">reference.png</div>
      <button data-testid="hatch-composer-stop-button">Stop</button>
    </form>
  </body></html>`;
  const script = `const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(temporary, "profile"))});
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(fixture)}));
      const result = await window.webContents.executeJavaScript(${JSON.stringify(`(${readMusePage.toString()})()`)});
      console.log('SENMUSE_FIXTURE=' + JSON.stringify(result));
      window.destroy(); app.quit();
    }).catch(error => { console.error(error); app.exit(1); });`;
  const scriptPath = path.join(temporary, "fixture.cjs");
  await fs.writeFile(scriptPath, script);
  const electronDirectory = path.resolve("node_modules/electron");
  const executable = path.join(
    electronDirectory,
    "dist",
    (
      await fs.readFile(path.join(electronDirectory, "path.txt"), "utf8")
    ).trim(),
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const { stdout } = await promisify(execFile)(executable, [scriptPath], {
      env: environment,
      timeout: 25_000,
    });
    const line = stdout
      .split("\n")
      .find((value) => value.startsWith("SENMUSE_FIXTURE="));
    expect(line).toBeTruthy();
    const page = JSON.parse(line!.slice("SENMUSE_FIXTURE=".length)) as MusePage;
    expect(page.composers).toBe(1);
    expect(page.sendButtons).toBe(1);
    expect(page.busy).toBe(true);
    expect(page.attachments).toBe(1);
    expect(page.messages.map((message) => [message.id, message.role])).toEqual([
      ["u1", "user"],
      ["a1", "assistant"],
    ]);
    expect(page.media).toEqual([
      { url: "blob:https://muse.ai/fixture", kind: "video" },
    ]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
