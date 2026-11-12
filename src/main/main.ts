import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store } from "./store";
import { MuseDriver } from "./muse";
import { renderProject } from "./render";
import { LocalApi } from "./server";
import type {
  AppState,
  Asset,
  CreateJob,
  ExportStatus,
  Job,
  MuseStatus,
  Project,
} from "../shared/types";
import {
  createJobSchema,
  projectSchema,
  settingsSchema,
} from "../shared/validation";

app.setName("SenMuse");
if (process.env.SENMUSE_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.SENMUSE_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "senmuse",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow;
let store: Store;
let muse: MuseDriver;
let api: LocalApi;
let museStatus: MuseStatus = {
  state: "unknown",
  message: "登录 Muse 后即可开始生成",
};
let active: { job: Job; abort: AbortController } | undefined;
const exports = new Map<string, ExportStatus>();
const exportControllers = new Map<string, AbortController>();
let token: string;
let shuttingDown = false;
let settingsWrites: Promise<unknown> = Promise.resolve();

function state(): AppState {
  return structuredClone({
    ...store.data,
    muse: museStatus,
    exports: [...exports.values()],
    version: app.getVersion(),
    api: api.status(),
  });
}

function publish(): void {
  if (window && !window.isDestroyed())
    window.webContents.send("senmuse:state", state());
}

function updateJob(job: Job, patch: Partial<Job>): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
  store.save();
  publish();
}

function assetById(id: string): Asset {
  const asset = store.data.assets.find((item) => item.id === id);
  if (!asset || !fs.existsSync(asset.path))
    throw new Error("素材文件不存在，请重新导入。");
  return asset;
}

function addAsset(
  file: string,
  kind: Asset["kind"],
  name: string,
  jobId?: string,
): Asset {
  const id = randomUUID();
  return {
    id,
    name,
    kind,
    path: file,
    url: `senmuse://asset/${id}`,
    createdAt: Date.now(),
    jobId,
  };
}

function importFile(file: string): Asset {
  const ext = path.extname(file).toLowerCase();
  const kind: Asset["kind"] = [".jpg", ".jpeg", ".png", ".webp"].includes(ext)
    ? "image"
    : [".mp4", ".mov", ".webm"].includes(ext)
      ? "video"
      : "audio";
  if (
    ![
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".mp4",
      ".mov",
      ".webm",
      ".mp3",
      ".wav",
      ".m4a",
      ".aac",
      ".ogg",
    ].includes(ext)
  )
    throw new Error("请选择 JPG、PNG、WebP、MP4、MOV、WebM 或常见音频文件。");
  const info = fs.statSync(file);
  const maxBytes = (kind === "image" ? 20 : 250) * 1024 * 1024;
  if (!info.isFile() || info.size === 0 || info.size > maxBytes)
    throw new Error(
      `素材不能为空，${kind === "image" ? "图片最大 20" : "视频或音频最大 250"} MB。`,
    );
  const dir = path.join(app.getPath("userData"), "assets");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${randomUUID()}${ext}`);
  fs.copyFileSync(file, target);
  const asset = addAsset(target, kind, path.basename(file));
  store.data.assets.unshift(asset);
  store.save();
  publish();
  return asset;
}

function createJob(raw: unknown): Job {
  const input: CreateJob = createJobSchema.parse(raw);
  const existing = store.findRequest(input);
  if (existing) return existing;
  const references = (input.referenceIds ?? []).map(assetById);
  if (references.some((asset) => asset.kind === "audio"))
    throw new Error("生成参考素材请选择图片或 MP4。");
  if (
    input.kind === "edit" &&
    (references.length !== 1 ||
      path.extname(references[0].path).toLowerCase() !== ".mp4")
  )
    throw new Error("修改视频需要选择一个 MP4 文件。");
  if (
    input.kind !== "edit" &&
    input.kind !== "extend" &&
    references.some((asset) => asset.kind !== "image")
  )
    throw new Error("图片和视频生成仅接受图片参考。");
  if (input.kind === "extend") {
    const source =
      references.length === 1
        ? store.data.jobs.find(
            (job) =>
              job.id === references[0].jobId && job.status === "completed",
          )
        : undefined;
    if (!source?.conversationUrl || references[0]?.kind !== "video")
      throw new Error("续拍请选择本应用生成的视频，它需要原来的 Muse 会话。");
    const newest = store.data.jobs.find(
      (job) =>
        job.conversationUrl === source.conversationUrl &&
        job.status === "completed",
    );
    if (newest?.id !== source.id)
      throw new Error("这个会话已有更新的视频，请选择最新版本续拍。");
    if (
      store.data.jobs.some(
        (job) =>
          job.conversationUrl === source.conversationUrl &&
          ["queued", "running", "needs_review"].includes(job.status),
      )
    )
      throw new Error("这个会话已有待处理的续拍任务。");
    input.conversationUrl = source.conversationUrl;
  } else input.conversationUrl = undefined;
  const job = store.createJob(input);
  publish();
  void pump();
  return job;
}

async function pump(): Promise<void> {
  if (active || shuttingDown || store.data.queuePaused) return;
  const job = [...store.data.jobs]
    .reverse()
    .find((item) => item.status === "queued");
  if (!job) return;
  const abort = new AbortController();
  active = { job, abort };
  updateJob(job, {
    status: "running",
    progress: "正在连接 Muse",
    error: undefined,
  });
  try {
    const result = await muse.run(
      job,
      job.referenceIds.map(assetById),
      {
        onProgress: (message) => updateJob(job, { progress: message }),
        onSubmitted: (conversationUrl) =>
          updateJob(job, {
            submittedAt: job.submittedAt ?? Date.now(),
            conversationUrl,
            progress: "Muse 正在生成，请稍候",
          }),
      },
      abort.signal,
    );
    if (!result.files.length) throw new Error("Muse 没有返回可保存的素材。");
    const assets = result.files.map((file) =>
      addAsset(file.path, file.kind, file.name, job.id),
    );
    store.completeJob(job, assets, result.conversationUrl);
    publish();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "生成失败，请检查连接。";
    const submitted =
      !!job.submittedAt || !!(error as { submitted?: boolean }).submitted;
    const status = submitted
      ? "needs_review"
      : abort.signal.aborted
        ? "cancelled"
        : "failed";
    if (submitted) store.data.queuePaused = true;
    updateJob(job, {
      status,
      error: message,
      progress: submitted ? "请在 Muse 检查结果，队列已暂停" : message,
    });
  } finally {
    active = undefined;
    if (!shuttingDown) setTimeout(() => void pump(), 500);
  }
}

function retryJob(id: string): Job {
  const job = store.data.jobs.find((item) => item.id === id);
  if (!job || !["failed", "cancelled", "needs_review"].includes(job.status))
    throw new Error("当前任务无法重试。");
  if (job.projectId) {
    const shot = store.data.projects
      .find((item) => item.id === job.projectId)
      ?.shots.find((item) => item.id === job.shotId);
    if (!shot || shot.jobId !== job.id || shot.prompt !== job.prompt)
      throw new Error("这个镜头已经修改，请在分镜页面重新生成，旧任务会保留。");
  }
  updateJob(job, {
    status: "queued",
    progress: "等待重试",
    error: undefined,
    submittedAt: undefined,
  });
  void pump();
  return job;
}

function cancelJob(id: string): void {
  const job = store.data.jobs.find((item) => item.id === id);
  if (!job) throw new Error("任务不存在。");
  if (active?.job.id === id) {
    active.abort.abort();
    return;
  }
  if (job.status === "queued")
    updateJob(job, { status: "cancelled", progress: "已取消" });
  if (job.status === "needs_review")
    updateJob(job, {
      status: "cancelled",
      progress: "已结束本地跟踪，Muse 中的任务可能仍在运行",
    });
}

function projectById(id: string): Project {
  const project = store.data.projects.find((item) => item.id === id);
  if (!project) throw new Error("项目不存在。");
  return project;
}

async function exportProject(id: string): Promise<void> {
  if (exports.get(id)?.state === "rendering")
    throw new Error("这个项目正在导出。");
  const project = structuredClone(projectById(id));
  if (!project.shots.length || project.shots.some((shot) => !shot.assetId))
    throw new Error("请先为每个镜头生成或选择素材。");
  const abort = new AbortController();
  exportControllers.set(id, abort);
  exports.set(id, { projectId: id, state: "rendering", progress: 0 });
  publish();
  void renderProject(project, structuredClone(store.data.assets), {
    outputDir: store.data.settings.outputDir,
    signal: abort.signal,
    onProgress: (progress) => {
      exports.set(id, { projectId: id, state: "rendering", progress });
      publish();
    },
  })
    .then((result) => {
      const asset = addAsset(result.path, "video", result.name);
      store.data.assets.unshift(asset);
      const current = store.data.projects.find((item) => item.id === id);
      if (current && current.revision === project.revision) {
        current.exportAssetId = asset.id;
        current.revision++;
      }
      store.save();
      exports.set(id, {
        projectId: id,
        state: "completed",
        progress: 100,
        assetId: asset.id,
      });
    })
    .catch((error) => {
      exports.set(id, {
        projectId: id,
        state: "failed",
        progress: 0,
        error: error instanceof Error ? error.message : "导出失败",
      });
    })
    .finally(() => {
      exportControllers.delete(id);
      publish();
    });
}

const objectId = z.object({ id: z.string().uuid() });
async function command(name: string, raw: unknown): Promise<unknown> {
  switch (name) {
    case "state.get":
      return state();
    case "app.info":
      return {
        mcpScript: path.join(app.getAppPath(), "scripts", "mcp.mjs"),
        nodeCommand: "node",
      };
    case "app.quit":
      app.quit();
      return null;
    case "muse.open":
      await muse.open();
      return null;
    case "muse.inspect":
      museStatus = await muse.inspect();
      publish();
      return museStatus;
    case "job.create":
      return createJob(raw);
    case "job.cancel":
      cancelJob(objectId.parse(raw).id);
      return null;
    case "job.retry":
      return retryJob(objectId.parse(raw).id);
    case "queue.pause":
      store.data.queuePaused = z
        .object({ paused: z.boolean() })
        .parse(raw).paused;
      store.save();
      publish();
      void pump();
      return null;
    case "media.pick": {
      const kind = z
        .object({
          kind: z.enum(["image", "video", "audio", "any"]).default("any"),
        })
        .parse(raw).kind;
      const extensions = {
        image: ["png", "jpg", "jpeg", "webp"],
        video: ["mp4", "mov", "webm"],
        audio: ["mp3", "wav", "m4a", "aac", "ogg"],
        any: [
          "png",
          "jpg",
          "jpeg",
          "webp",
          "mp4",
          "mov",
          "webm",
          "mp3",
          "wav",
          "m4a",
          "aac",
          "ogg",
        ],
      };
      const result = await dialog.showOpenDialog(window, {
        title: "选择素材",
        properties: ["openFile"],
        filters: [{ name: "素材文件", extensions: extensions[kind] }],
      });
      return result.canceled ? null : importFile(result.filePaths[0]);
    }
    case "media.import":
      return importFile(z.object({ path: z.string().min(1) }).parse(raw).path);
    case "media.reveal":
      shell.showItemInFolder(assetById(objectId.parse(raw).id).path);
      return null;
    case "project.save": {
      const input = projectSchema.parse(
        z.object({ project: z.unknown() }).parse(raw).project,
      );
      const existing = store.data.projects.find((item) => item.id === input.id);
      for (const shot of existing?.shots ?? []) {
        const job = store.data.jobs.find((item) => item.id === shot.jobId);
        if (!job || !["queued", "running", "needs_review"].includes(job.status))
          continue;
        const next = input.shots.find((item) => item.id === shot.id);
        if (
          !next ||
          next.prompt !== shot.prompt ||
          next.assetId !== shot.assetId
        )
          throw new Error("请等待这个镜头的生成任务完成，或先取消任务再修改。");
      }
      const project = store.saveProject(input);
      publish();
      return project;
    }
    case "project.generate": {
      const { id, shotId } = z
        .object({ id: z.string().uuid(), shotId: z.string().uuid().optional() })
        .parse(raw);
      const project = projectById(id);
      const shots = project.shots.filter((shot) =>
        shotId
          ? shot.id === shotId
          : !shot.assetId &&
            !store.data.jobs.some(
              (job) =>
                job.id === shot.jobId &&
                ["queued", "running", "needs_review"].includes(job.status),
            ),
      );
      if (!shots.length)
        throw new Error("没有待生成的镜头。可以在指定镜头上选择重新生成。");
      if (shots.some((shot) => !shot.prompt.trim()))
        throw new Error("请填写每个镜头的画面描述。");
      for (const shot of shots)
        createJob({
          kind: "video",
          prompt: shot.prompt,
          requestId: randomUUID(),
          projectId: id,
          shotId: shot.id,
        });
      return projectById(id);
    }
    case "project.export":
      await exportProject(objectId.parse(raw).id);
      return null;
    case "project.delete": {
      const { id } = objectId.parse(raw);
      if (
        exports.get(id)?.state === "rendering" ||
        store.data.jobs.some(
          (job) =>
            job.projectId === id &&
            ["queued", "running", "needs_review"].includes(job.status),
        )
      )
        throw new Error("项目有待处理任务，请先完成或取消。");
      store.data.projects = store.data.projects.filter(
        (item) => item.id !== id,
      );
      store.save();
      publish();
      return null;
    }
    case "settings.pickDirectory": {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case "settings.save": {
      const settings = settingsSchema.parse({
        ...store.data.settings,
        ...(raw as object),
      });
      if (active && settings.proxy !== store.data.settings.proxy)
        throw new Error("请等待当前生成任务完成后再修改网络设置。");
      fs.mkdirSync(settings.outputDir, { recursive: true });
      const probe = path.join(
        settings.outputDir,
        `.senmuse-write-${randomUUID()}`,
      );
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      if (settings.proxy !== store.data.settings.proxy)
        await muse.setProxy(settings.proxy);
      const apiChanged =
        settings.apiEnabled !== store.data.settings.apiEnabled ||
        settings.apiPort !== store.data.settings.apiPort;
      store.data.settings = settings;
      store.save();
      if (apiChanged)
        await api.configure(settings.apiEnabled, settings.apiPort);
      publish();
      return settings;
    }
    case "api.token":
      return token;
    case "app.openExternal": {
      const { url } = z.object({ url: z.string().url() }).parse(raw);
      if (new URL(url).protocol !== "https:")
        throw new Error("仅支持 HTTPS 链接。");
      await shell.openExternal(url);
      return null;
    }
    default:
      throw new Error("不支持的操作。");
  }
}

async function start(): Promise<void> {
  const dataDir = app.getPath("userData");
  store = new Store(
    path.join(dataDir, "state.json"),
    path.join(app.getPath("videos"), "SenMuse"),
  );
  const tokenFile = path.join(dataDir, "api-token");
  token = fs.existsSync(tokenFile)
    ? fs.readFileSync(tokenFile, "utf8").trim()
    : randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  muse = new MuseDriver({
    downloadDir: path.join(dataDir, "generated"),
    onStatus: (status) => {
      museStatus = status;
      if (api) publish();
    },
  });
  await muse.setProxy(store.data.settings.proxy);
  api = new LocalApi(token, {
    state,
    createJob,
    cancelJob,
    retryJob,
    exportProject,
  });
  await api.configure(
    store.data.settings.apiEnabled,
    store.data.settings.apiPort,
  );
  protocol.handle("senmuse", async (request) => {
    const url = new URL(request.url);
    const asset =
      url.hostname === "asset"
        ? store.data.assets.find((item) => item.id === url.pathname.slice(1))
        : undefined;
    if (!asset || !fs.existsSync(asset.path))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(asset.path).href, {
      headers: request.headers,
    });
  });
  window = new BrowserWindow({
    width: 1370,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    title: "森映 · SenMuse",
    backgroundColor: "#f6f7f2",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("senmuse:command", async (event, name, input) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return { ok: false, error: "请求来源无效" };
    try {
      if (name === "settings.save") {
        const operation = settingsWrites.then(() => command(name, input));
        settingsWrites = operation.catch(() => undefined);
        return { ok: true, data: await operation };
      }
      return { ok: true, data: await command(name, input) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join("；")
            : error instanceof Error
              ? error.message
              : "操作失败，请重试。",
      };
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      ...(process.platform === "darwin"
        ? []
        : [{ label: "文件", submenu: [{ role: "quit" as const }] }]),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  window.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      window.hide();
    }
  });
  if (process.env.SENMUSE_DEV_URL)
    await window.loadURL(process.env.SENMUSE_DEV_URL);
  else await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  void pump();
}

app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
app.on("activate", () => {
  window?.show();
});
app.on("before-quit", () => {
  shuttingDown = true;
  active?.abort.abort();
  for (const abort of exportControllers.values()) abort.abort();
});
if (locked)
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox(
        "森映无法启动",
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
