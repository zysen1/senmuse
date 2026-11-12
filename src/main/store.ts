import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Asset, CreateJob, Job, Project, Settings } from "../shared/types";

interface SavedState {
  schema: 1;
  settings: Settings;
  jobs: Job[];
  assets: Asset[];
  projects: Project[];
  requests: Record<string, string>;
  queuePaused: boolean;
}

export class Store {
  data: SavedState;
  constructor(
    private file: string,
    defaultOutput: string,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {
          schema: 1,
          settings: {
            outputDir: defaultOutput,
            proxy: "",
            apiEnabled: false,
            apiPort: 47831,
          },
          jobs: [],
          assets: [],
          projects: [],
          requests: {},
          queuePaused: false,
        };
    if (
      this.data.schema !== 1 ||
      !Array.isArray(this.data.jobs) ||
      !Array.isArray(this.data.projects)
    )
      throw new Error("项目数据版本无法读取，请保留数据文件并联系维护者。");
    for (const job of this.data.jobs) {
      if (job.status !== "running") continue;
      job.status = job.submittedAt ? "needs_review" : "queued";
      if (job.submittedAt) this.data.queuePaused = true;
      job.progress = job.submittedAt
        ? "应用重启，请先检查 Muse 中的结果再决定是否重试"
        : "等待继续";
      job.updatedAt = Date.now();
    }
    this.save();
  }

  save(): void {
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
  }

  findRequest(input: CreateJob): Job | undefined {
    const key = createHash("sha256").update(input.requestId).digest("hex");
    const existing = Object.hasOwn(this.data.requests, key)
      ? this.data.requests[key]
      : Object.hasOwn(this.data.requests, input.requestId)
        ? this.data.requests[input.requestId]
        : undefined;
    if (existing) {
      const job = this.data.jobs.find((item) => item.id === existing);
      if (job) {
        const same =
          job.kind === input.kind &&
          job.prompt === input.prompt &&
          JSON.stringify(job.referenceIds) ===
            JSON.stringify(input.referenceIds ?? []) &&
          job.projectId === input.projectId &&
          job.shotId === input.shotId;
        if (!same)
          throw new Error(
            "这个 requestId 已用于另一项生成，请为新的任务换一个 requestId。",
          );
        return job;
      }
    }
    return undefined;
  }

  createJob(input: CreateJob): Job {
    const existing = this.findRequest(input);
    if (existing) return existing;
    for (const id of input.referenceIds ?? [])
      if (!this.data.assets.some((asset) => asset.id === id))
        throw new Error("参考素材已不存在，请重新选择。");
    const project = input.projectId
      ? this.data.projects.find((item) => item.id === input.projectId)
      : undefined;
    const shot = project?.shots.find((item) => item.id === input.shotId);
    if (input.projectId && !shot) throw new Error("分镜已被移除，请刷新项目。");
    if (shot?.jobId) {
      const previous = this.data.jobs.find((item) => item.id === shot.jobId);
      if (
        previous &&
        ["queued", "running", "needs_review"].includes(previous.status)
      )
        throw new Error("这个镜头已有未完成任务，请先处理原任务。");
    }
    const job: Job = {
      id: randomUUID(),
      kind: input.kind,
      prompt: input.prompt,
      referenceIds: input.referenceIds ?? [],
      status: "queued",
      progress: "等待生成",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assetIds: [],
      conversationUrl: input.conversationUrl,
      projectId: input.projectId,
      shotId: input.shotId,
    };
    this.data.jobs.unshift(job);
    this.data.requests[
      createHash("sha256").update(input.requestId).digest("hex")
    ] = job.id;
    if (shot && project) {
      shot.jobId = job.id;
      project.revision++;
      project.updatedAt = Date.now();
    }
    this.save();
    return job;
  }

  saveProject(input: Project): Project {
    const existing = this.data.projects.find((item) => item.id === input.id);
    if (existing && input.revision !== existing.revision)
      throw new Error(
        "项目刚刚有新结果，请载入最新项目后再保存，避免覆盖新素材。",
      );
    if (new Set(input.shots.map((shot) => shot.id)).size !== input.shots.length)
      throw new Error("镜头编号重复，请重新创建镜头。");
    for (const shot of input.shots) {
      if (
        shot.assetId &&
        !this.data.assets.some(
          (asset) => asset.id === shot.assetId && asset.kind !== "audio",
        )
      )
        throw new Error("镜头素材不存在或格式不支持。");
    }
    if (
      input.audioAssetId &&
      !this.data.assets.some(
        (asset) => asset.id === input.audioAssetId && asset.kind === "audio",
      )
    )
      throw new Error("请选择有效的音频素材。");
    const value = structuredClone(input);
    value.revision = (existing?.revision ?? 0) + 1;
    value.updatedAt = Date.now();
    // Generated task ownership is main-process data, never overwritten by a stale renderer draft.
    for (const shot of value.shots) {
      const previous = existing?.shots.find((item) => item.id === shot.id);
      shot.jobId =
        previous?.prompt === shot.prompt && previous.assetId === shot.assetId
          ? previous.jobId
          : undefined;
    }
    if (existing)
      this.data.projects[this.data.projects.indexOf(existing)] = value;
    else this.data.projects.unshift(value);
    this.save();
    return value;
  }

  completeJob(job: Job, assets: Asset[], conversationUrl: string): void {
    this.data.assets.unshift(...assets);
    Object.assign(job, {
      status: "completed",
      progress: "生成完成",
      assetIds: assets.map((asset) => asset.id),
      conversationUrl,
      updatedAt: Date.now(),
    });
    const project = this.data.projects.find(
      (item) => item.id === job.projectId,
    );
    const shot = project?.shots.find(
      (item) => item.id === job.shotId && item.jobId === job.id,
    );
    if (project && shot && assets[0]) {
      shot.assetId = assets[0].id;
      project.revision++;
      project.updatedAt = Date.now();
    }
    this.save();
  }
}
