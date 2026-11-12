import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  ApiJob,
  ApiAsset,
  GenerationProvider,
  ProviderStatus,
} from "./types.ts";
import {
  ApiError,
  generationInput,
  mediaType,
  safeMessage,
} from "./validation.ts";
interface Saved {
  version: 1;
  jobs: ApiJob[];
  assets: ApiAsset[];
  requests: Record<string, { id: string; fingerprint: string }>;
  paused: boolean;
}
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
export class ApiEngine {
  data: Saved;
  dir: string;
  provider: GenerationProvider;
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private stopping = false;
  private connecting?: Promise<ProviderStatus>;
  private lastStatus?: { at: number; value: ProviderStatus };
  constructor(dir: string, provider: GenerationProvider) {
    this.dir = dir;
    this.provider = provider;
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "work"), { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.stateFile())
      ? JSON.parse(fs.readFileSync(this.stateFile(), "utf8"))
      : { version: 1, jobs: [], assets: [], requests: {}, paused: false };
    if (
      this.data.version !== 1 ||
      !Array.isArray(this.data.jobs) ||
      !Array.isArray(this.data.assets) ||
      !this.data.requests
    )
      throw new Error("API 数据格式无法读取，请保留数据文件");
    for (const job of this.data.jobs)
      if (job.status === "running") {
        job.status = job.submittedAt ? "needs_review" : "queued";
        job.progress = job.submittedAt
          ? "服务重启：可能已提交，请检查 Muse 结果后处理"
          : "等待恢复";
        if (job.submittedAt) this.data.paused = true;
        job.updatedAt = new Date().toISOString();
      }
    this.save();
  }
  private stateFile() {
    return path.join(this.dir, "state.json");
  }
  private save() {
    const temp = this.stateFile() + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.stateFile());
  }
  private update(job: ApiJob, patch: Partial<ApiJob>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save();
  }
  async status(refresh = false): Promise<ProviderStatus> {
    if (!refresh && this.lastStatus && Date.now() - this.lastStatus.at < 5000)
      return this.lastStatus.value;
    this.connecting ??= this.provider.status().catch((error) => ({
      state: "error" as const,
      message: safeMessage(error),
      capabilities: [],
    }));
    try {
      const raw = await this.connecting;
      const value = { ...raw, message: safeMessage(new Error(raw.message)) };
      this.lastStatus = { at: Date.now(), value };
      return value;
    } finally {
      this.connecting = undefined;
    }
  }
  create(input: unknown): ApiJob {
    const request = generationInput(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const requestKey = createHash("sha256")
      .update(request.requestId)
      .digest("hex");
    const existing = this.data.requests[requestKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "此 requestId 已用于不同请求；新的生成请使用新 ID",
        );
      return this.job(existing.id);
    }
    if (
      this.data.jobs.filter((job) => ["queued", "running"].includes(job.status))
        .length >= 100
    )
      throw new ApiError(429, "队列已满，请等现有任务完成");
    if (this.data.jobs.length >= 10000)
      throw new ApiError(
        507,
        "任务记录已达 10000 条，请归档数据目录后启动新的工作区",
      );
    for (const id of request.referenceIds)
      if (!this.data.assets.some((asset) => asset.id === id))
        throw new ApiError(400, `参考素材不存在：${id}`);
    if (
      request.kind === "edit" &&
      !request.referenceIds.some((id) =>
        this.asset(id).mime.startsWith("video/"),
      )
    )
      throw new ApiError(400, "改片至少需要一个视频素材");
    const now = new Date().toISOString();
    const job: ApiJob = {
      ...request,
      id: randomUUID(),
      status: "queued",
      progress: "等待生成",
      createdAt: now,
      updatedAt: now,
      assetIds: [],
    };
    this.data.jobs.unshift(job);
    this.data.requests[requestKey] = { id: job.id, fingerprint };
    this.save();
    queueMicrotask(() => this.pump());
    return job;
  }
  job(id: string): ApiJob {
    const job = this.data.jobs.find((value) => value.id === id);
    if (!job) throw new ApiError(404, "任务不存在");
    return job;
  }
  asset(id: string): ApiAsset {
    const asset = this.data.assets.find((value) => value.id === id);
    if (!asset) throw new ApiError(404, "素材不存在");
    return asset;
  }
  cancel(id: string): ApiJob {
    const job = this.job(id);
    if (job.status === "running") {
      this.active?.id === id && this.active.controller.abort();
      this.update(job, {
        status: job.submittedAt ? "needs_review" : "cancelled",
        progress: job.submittedAt
          ? "已停止等待；Muse 可能继续生成，请检查后处理"
          : "已取消",
      });
      if (job.submittedAt) {
        this.data.paused = true;
        this.save();
      }
    } else if (job.status === "queued")
      this.update(job, { status: "cancelled", progress: "已取消" });
    return job;
  }
  resolve(id: string, action: unknown): ApiJob {
    const job = this.job(id);
    if (this.active?.id === id)
      throw new ApiError(409, "任务正在停止，请稍后再处理");
    if (job.status !== "needs_review" || action !== "acknowledge")
      throw new ApiError(
        400,
        "仅可使用 action: acknowledge 确认已检查 needs_review 任务",
      );
    this.update(job, {
      status: "cancelled",
      progress: "已人工确认；如需重做，请使用新的 requestId",
    });
    return job;
  }
  pause(value: boolean) {
    if (!value && this.data.jobs.some((job) => job.status === "needs_review"))
      throw new ApiError(
        409,
        "请先检查并确认 needs_review 任务，以免重复消耗额度",
      );
    this.data.paused = value;
    this.save();
    if (!value) queueMicrotask(() => this.pump());
  }
  private inspectFile(file: string) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_ASSET_BYTES)
      throw new ApiError(400, "素材需要是 1 字节至 200 MiB 的常规文件");
    const fd = fs.openSync(file, "r");
    const prefix = Buffer.alloc(16);
    let bytes: number;
    try {
      bytes = fs.readSync(fd, prefix, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    const type = mediaType(prefix.subarray(0, bytes!));
    if (!type)
      throw new ApiError(
        400,
        "素材内容不属于支持的 MP4、WebM、PNG、JPEG 或 WebP 格式",
      );
    return { ...type, size: stat.size };
  }
  importFile(file: string, name: string, jobId?: string): ApiAsset {
    return this.importFiles([{ file, name }], jobId)[0];
  }
  private importFiles(
    files: { file: string; name: string }[],
    jobId?: string,
  ): ApiAsset[] {
    const checked = files.map((item) => ({
      ...item,
      ...this.inspectFile(item.file),
    }));
    const imported: ApiAsset[] = [];
    try {
      for (const item of checked) {
        const id = randomUUID();
        const dest = path.join(this.dir, "assets", `${id}.${item.ext}`);
        fs.copyFileSync(item.file, dest, fs.constants.COPYFILE_EXCL);
        imported.push({
          id,
          name:
            path
              .basename(item.name)
              .replace(/[\x00-\x1f\x7f]/g, "")
              .slice(0, 180) || `${id}.${item.ext}`,
          mime: item.mime,
          path: dest,
          size: item.size,
          createdAt: new Date().toISOString(),
          ...(jobId ? { jobId } : {}),
        });
        fs.chmodSync(dest, 0o600);
      }
    } catch (error) {
      for (const item of imported) fs.rmSync(item.path, { force: true });
      throw error;
    }
    this.data.assets.unshift(...imported);
    this.save();
    return imported;
  }
  publicAsset(asset: ApiAsset) {
    const { path: _path, ...rest } = asset;
    return { ...rest, downloadUrl: `/v1/assets/${asset.id}/file` };
  }
  pump() {
    if (this.stopping || this.active || this.data.paused) return;
    const job = [...this.data.jobs]
      .reverse()
      .find((job) => job.status === "queued");
    if (!job) return;
    const controller = new AbortController();
    const active = { id: job.id, controller, done: Promise.resolve() };
    this.active = active;
    active.done = this.run(job, controller)
      .catch((error) => {
        // A failed state write must stop dispatch, including when recording the
        // original failure itself was impossible (disk full, permissions, etc.).
        this.data.paused = true;
        Object.assign(job, {
          status: job.submittedAt ? "needs_review" : "failed",
          progress: "服务存储异常，队列已暂停；请检查磁盘与数据目录",
          error: safeMessage(error),
          updatedAt: new Date().toISOString(),
        });
        try {
          this.save();
        } catch {
          /* Keep dispatch stopped even if persistence is unavailable. */
        }
      })
      .finally(() => {
        this.active = undefined;
        if (!this.stopping) queueMicrotask(() => this.pump());
      });
  }
  private async run(job: ApiJob, controller: AbortController) {
    const outputDir = path.join(this.dir, "work", job.id);
    const timeout = setTimeout(
      () => controller.abort(new Error("等待生成超过 30 分钟")),
      30 * 60_000,
    );
    try {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      this.update(job, { status: "running", progress: "检查 Muse 连接" });
      const status = await this.status(true);
      if (controller.signal.aborted) throw new Error("已停止任务");
      if (status.state !== "ready") throw new Error(status.message);
      if (!status.capabilities.includes(job.kind))
        throw new Error("当前生成组件没有声明支持此任务类型");
      const result = await this.provider.run(
        {
          ...job,
          jobId: job.id,
          references: job.referenceIds.map((id) => {
            const a = this.asset(id);
            return { path: a.path, mime: a.mime, name: a.name };
          }),
        },
        {
          signal: controller.signal,
          outputDir,
          onSubmitted: (conversationId) => {
            this.update(job, {
              submittedAt: job.submittedAt ?? new Date().toISOString(),
            });
            if (conversationId) {
              if (!/^[A-Za-z0-9_-]{1,150}$/.test(conversationId))
                throw new Error("生成组件返回了无效的会话编号");
              this.update(job, { conversationId });
            }
          },
          onProgress: (message) => {
            if (job.status === "running")
              this.update(job, {
                progress: safeMessage(new Error(message)).slice(0, 300),
              });
          },
        },
      );
      if (controller.signal.aborted || job.status !== "running")
        throw new Error("已停止等待，结果需要检查");
      if (
        !Array.isArray(result.files) ||
        !result.files.length ||
        result.files.length > 20
      )
        throw new Error("Muse 没有返回可保存的生成素材");
      const realRoot = fs.realpathSync(outputDir) + path.sep;
      const paths = result.files.map((file) => {
        const real = fs.realpathSync(file.path);
        if (!real.startsWith(realRoot))
          throw new Error("生成组件返回了输出目录之外的文件");
        return real;
      });
      const types = paths.map((file) => this.inspectFile(file));
      if (
        job.kind !== "image" &&
        !types.some((a) => a.mime.startsWith("video/"))
      )
        throw new Error("本次要求生成视频，但没有返回视频文件");
      if (
        job.kind === "image" &&
        !types.some((a) => a.mime.startsWith("image/"))
      )
        throw new Error("本次要求生成图片，但没有返回图片文件");
      const assets = this.importFiles(
        result.files.map((file, i) => ({
          file: paths[i],
          name: file.name ?? path.basename(paths[i]),
        })),
        job.id,
      );
      this.update(job, {
        status: "completed",
        progress: "生成完成",
        assetIds: assets.map((a) => a.id),
        conversationId: result.conversationId ?? job.conversationId,
      });
    } catch (error) {
      if (job.submittedAt) {
        this.data.paused = true;
        this.update(job, {
          status: "needs_review",
          error: safeMessage(error),
          progress: "可能已提交给 Muse；请检查结果，不会自动重试",
        });
      } else if (controller.signal.aborted)
        this.update(job, { status: "cancelled", progress: "已停止" });
      else
        this.update(job, {
          status: "failed",
          error: safeMessage(error),
          progress: "生成前检查失败",
        });
    } finally {
      clearTimeout(timeout);
    }
  }
  async close() {
    this.stopping = true;
    this.active?.controller.abort();
    await Promise.all([this.provider.close(), this.active?.done]);
  }
}
