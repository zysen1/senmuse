import type { Dispatch, SetStateAction } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Film,
  ImageIcon,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import type { AppState, Asset, CreateJob, Job, JobKind } from "../shared/types";
import {
  AssetThumb,
  Button,
  IconButton,
  Status,
  formatDate,
  invoke,
  kindLabels,
  type Run,
} from "./ui";

export interface StudioDraft {
  kind: JobKind;
  prompt: string;
  referenceIds: string[];
  requestId: string;
}
interface Props {
  state: AppState;
  draft: StudioDraft;
  setDraft: Dispatch<SetStateAction<StudioDraft>>;
  run: Run;
  busy: Set<string>;
  onPreview: (asset: Asset) => void;
  onQueue: () => void;
  onNotice: (message: string) => void;
}
const modes = [
  { id: "video", label: "视频", icon: Film },
  { id: "image", label: "图片", icon: ImageIcon },
  { id: "edit", label: "改片", icon: WandSparkles },
  { id: "extend", label: "续拍", icon: RefreshCw },
] as const;
const placeholders: Record<JobKind, string> = {
  video:
    "描述你想看到的画面。\n例如：清晨的咖啡馆，阳光落在一杯热拿铁上，镜头缓慢推近，暖色调，竖屏。",
  image:
    "描述画面中的主体、环境和光线。\n例如：木桌上的白色陶瓷杯，窗外竹影，柔和自然光，极简产品摄影。",
  edit: "描述这段视频需要修改的地方。\n例如：把背景改成雨夜的街道，保留人物的动作和服装。",
  extend:
    "描述接下来发生什么。\n例如：镜头继续向前推进，经过窗边，露出远处的山景。",
};
const examples = [
  {
    label: "产品特写",
    prompt:
      "一瓶透明香水放在浅色石台上，水面反射柔和阳光，镜头缓慢环绕，精致产品广告，竖屏。",
  },
  {
    label: "自然风景",
    prompt:
      "清晨的山间小屋，薄雾穿过树林，镜头从溪流缓慢抬升，安静的电影质感，竖屏。",
  },
  {
    label: "城市夜景",
    prompt:
      "雨后的城市街道，霓虹灯映在地面，镜头低角度缓缓向前，写实电影摄影，竖屏。",
  },
];

export function Studio({
  state,
  draft,
  setDraft,
  run,
  busy,
  onPreview,
  onQueue,
  onNotice,
}: Props) {
  const references = draft.referenceIds
    .map((id) => state.assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset);
  const ready = state.muse.state === "ready" || state.muse.state === "busy";
  const recent = [...state.jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 4);
  const sourceVideos = state.assets.filter((asset) => {
    const job = state.jobs.find((item) => item.id === asset.jobId);
    if (
      asset.kind !== "video" ||
      !job?.conversationUrl ||
      job.status !== "completed"
    )
      return false;
    const newest = state.jobs
      .filter(
        (item) =>
          item.status === "completed" &&
          item.conversationUrl === job.conversationUrl,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return newest?.id === job.id;
  });
  const update = (patch: Partial<StudioDraft>) =>
    setDraft((current) => ({
      ...current,
      ...patch,
      requestId: crypto.randomUUID(),
    }));
  const needsVideo =
    draft.kind === "edit" &&
    !references.some((asset) => asset.kind === "video");
  const canSubmit =
    ready &&
    draft.prompt.trim().length > 0 &&
    !needsVideo &&
    (draft.kind !== "extend" || draft.referenceIds.length === 1);
  const addReference = async () => {
    if (draft.kind !== "edit" && draft.referenceIds.length >= 4) {
      onNotice("每个任务最多添加 4 张参考图片。");
      return;
    }
    const asset = await run("studio.pick", () =>
      invoke<Asset | null>("media.pick", {
        kind: draft.kind === "edit" ? "video" : "image",
      }),
    );
    if (
      asset &&
      draft.kind === "edit" &&
      !asset.name.toLowerCase().endsWith(".mp4")
    ) {
      onNotice("修改视频需要 MP4 格式，请重新选择。");
      return;
    }
    if (asset)
      update({
        referenceIds:
          draft.kind === "edit"
            ? [asset.id]
            : [...draft.referenceIds, asset.id],
      });
  };
  const submit = async () => {
    const input: CreateJob = {
      kind: draft.kind,
      prompt: draft.prompt.trim(),
      referenceIds: draft.referenceIds,
      requestId: draft.requestId,
    };
    const result = await run("job.create", () =>
      invoke<Job>("job.create", input),
    );
    if (result) {
      setDraft((current) => ({ ...current, requestId: crypto.randomUUID() }));
      onNotice("任务已加入队列。完成后可在下方预览，或到素材库查看。");
    }
  };
  return (
    <div className="studio-layout">
      <section className="composer card">
        <div className="mode-tabs" role="tablist" aria-label="创作类型">
          {modes.map((mode) => (
            <button
              role="tab"
              aria-selected={draft.kind === mode.id}
              key={mode.id}
              onClick={() => update({ kind: mode.id, referenceIds: [] })}
              className={draft.kind === mode.id ? "active" : ""}
            >
              <mode.icon size={17} />
              {mode.label}
            </button>
          ))}
        </div>
        <div className="composer-body">
          <div className="field-heading">
            <label htmlFor="prompt">
              {draft.kind === "edit"
                ? "修改要求"
                : draft.kind === "extend"
                  ? "接下来发生什么"
                  : "画面描述"}
            </label>
            <span>{draft.prompt.length} 字</span>
          </div>
          <textarea
            id="prompt"
            className="prompt-input"
            value={draft.prompt}
            onChange={(event) => update({ prompt: event.target.value })}
            placeholder={placeholders[draft.kind]}
            maxLength={12000}
          />
          {draft.kind === "extend" ? (
            <div className="field">
              <label htmlFor="source-video">选择要续拍的视频</label>
              <select
                id="source-video"
                value={draft.referenceIds[0] ?? ""}
                onChange={(event) =>
                  update({
                    referenceIds: event.target.value
                      ? [event.target.value]
                      : [],
                  })
                }
              >
                <option value="">选择本应用生成的视频</option>
                {sourceVideos.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                需要本应用生成的最新视频，以便继续原来的 Muse 会话。
                {sourceVideos.length === 0 &&
                  "先生成一段视频，完成后即可在这里续拍。"}
              </p>
              {references[0] && (
                <button
                  className="text-button"
                  onClick={() => onPreview(references[0])}
                >
                  <Play size={13} />
                  预览原视频
                </button>
              )}
            </div>
          ) : (
            <div className="references-section">
              <div className="field-heading">
                <span>
                  {draft.kind === "edit" ? "原始视频" : "参考图片"}{" "}
                  <small>{draft.kind === "edit" ? "必选" : "可选"}</small>
                </span>
                <Button
                  variant="ghost"
                  icon={<Plus size={15} />}
                  loading={busy.has("studio.pick")}
                  onClick={() => void addReference()}
                >
                  添加{draft.kind === "edit" ? "视频" : "图片"}
                </Button>
              </div>
              {references.length ? (
                <div className="reference-list">
                  {references.map((asset) => (
                    <div className="reference-item" key={asset.id}>
                      <button
                        className="thumb-button"
                        onClick={() => onPreview(asset)}
                      >
                        <AssetThumb asset={asset} />
                      </button>
                      <span title={asset.name}>{asset.name}</span>
                      <IconButton
                        label={`移除 ${asset.name}`}
                        onClick={() =>
                          update({
                            referenceIds: draft.referenceIds.filter(
                              (id) => id !== asset.id,
                            ),
                          })
                        }
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  className="reference-drop"
                  onClick={() => void addReference()}
                >
                  <Paperclip size={19} />
                  <span>
                    {draft.kind === "edit"
                      ? "选择一段 MP4，描述你想修改的地方"
                      : "添加参考图，帮助 Muse 理解主体与风格"}
                  </span>
                </button>
              )}
            </div>
          )}
          {draft.kind === "video" && !draft.prompt && (
            <div className="examples">
              <span>试试</span>
              {examples.map((example) => (
                <button
                  key={example.label}
                  onClick={() => update({ prompt: example.prompt })}
                >
                  {example.label}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-footer">
          <span className="muted">
            {!ready
              ? "先登录 Muse，再开始创作"
              : needsVideo
                ? "请先添加要修改的 MP4 视频"
                : "任务将在本机排队，使用你的 Muse 账号生成"}
          </span>
          <Button
            variant="primary"
            icon={<Sparkles size={17} />}
            loading={busy.has("job.create")}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {kindLabels[draft.kind]}
          </Button>
        </div>
      </section>
      <aside className="studio-aside">
        <div className="connection-panel card">
          <div className="panel-icon">
            <LeafIcon />
          </div>
          <h2>{ready ? "Muse 已就绪" : "连接你的 Muse"}</h2>
          <p>
            {ready
              ? state.muse.message || "现在可以提交生成任务。"
              : "在独立窗口登录 Muse，登录状态会保存在这台电脑上。"}
          </p>
          <Button
            icon={<ArrowUpRight size={15} />}
            loading={busy.has("muse.open")}
            onClick={() => void run("muse.open", () => invoke("muse.open"))}
          >
            {ready ? "打开 Muse 窗口" : "打开 Muse 并登录"}
          </Button>
          <button
            className="text-button"
            disabled={busy.has("muse.inspect")}
            onClick={() =>
              void run("muse.inspect", () => invoke("muse.inspect"))
            }
          >
            <RefreshCw
              size={13}
              className={busy.has("muse.inspect") ? "spin" : ""}
            />
            我已登录，检查连接
          </button>
        </div>
        <div className="tip-panel">
          <h3>让描述更具体</h3>
          <p>写清主体、场景、动作和镜头运动。参考图适合固定角色或商品外观。</p>
          <div className="prompt-formula">
            主体 <span>＋</span> 场景 <span>＋</span> 镜头
          </div>
        </div>
      </aside>
      <section className="recent-section">
        <div className="section-heading">
          <h2>最近创作</h2>
          <button className="text-button" onClick={onQueue}>
            查看全部任务 <ArrowRight size={15} />
          </button>
        </div>
        {recent.length ? (
          <div className="recent-grid">
            {recent.map((job) => {
              const asset = state.assets.find((item) =>
                job.assetIds.includes(item.id),
              );
              return (
                <button
                  className="recent-card"
                  key={job.id}
                  onClick={() => (asset ? onPreview(asset) : onQueue())}
                >
                  {asset ? (
                    <AssetThumb asset={asset} />
                  ) : (
                    <div className={`recent-placeholder ${job.status}`}>
                      <Film size={24} />
                      <Status status={job.status} />
                    </div>
                  )}
                  <div className="recent-info">
                    <p>{job.prompt}</p>
                    <div>
                      <span>{formatDate(job.createdAt)}</span>
                      {asset && <Play size={14} />}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="recent-empty">
            <Film size={24} />
            <div>
              <strong>你的第一帧，从这里开始</strong>
              <p>提交任务后，生成进度和作品会显示在这里。</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
function LeafIcon() {
  return <Sparkles size={24} strokeWidth={1.5} />;
}
