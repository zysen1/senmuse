import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clapperboard,
  Download,
  Film,
  ImageIcon,
  ListPlus,
  LoaderCircle,
  Music2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { AppState, Asset, Project, Shot } from "../shared/types";
import {
  AssetThumb,
  Button,
  EmptyState,
  IconButton,
  MediaPicker,
  Modal,
  Status,
  formatDate,
  invoke,
  type Run,
} from "./ui";

export interface ProjectDraft {
  project: Project;
  base?: Project;
  dirty: boolean;
}
interface Props {
  state: AppState;
  drafts: Record<string, ProjectDraft>;
  setDrafts: Dispatch<SetStateAction<Record<string, ProjectDraft>>>;
  selected: string | null;
  setSelected: (id: string | null) => void;
  run: Run;
  busy: Set<string>;
  onPreview: (asset: Asset) => void;
  onNotice: (message: string) => void;
}
const blankShot = (): Shot => ({
  id: crypto.randomUUID(),
  prompt: "",
  caption: "",
  duration: 5,
});

export function Projects({
  state,
  drafts,
  setDrafts,
  selected,
  setSelected,
  run,
  busy,
  onPreview,
  onNotice,
}: Props) {
  const [picker, setPicker] = useState<{
    shotId?: string;
    audio?: boolean;
  } | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [script, setScript] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const draft = selected ? drafts[selected] : undefined;
  const project = draft?.project;
  const locked =
    !!selected &&
    [
      "project.save:",
      "project.generate:",
      "project.export:",
      "project.delete:",
    ].some((prefix) => busy.has(prefix + selected));
  const exporting = state.exports.find((item) => item.projectId === selected);
  const list = Object.values(drafts).sort(
    (a, b) => b.project.updatedAt - a.project.updatedAt,
  );
  const closePicker = useCallback(() => setPicker(null), []);
  const closeSplit = useCallback(() => setSplitOpen(false), []);
  const closeDelete = useCallback(() => setDeleteOpen(false), []);
  const closeReload = useCallback(() => setReloadOpen(false), []);
  const latest = state.projects.find((item) => item.id === selected);
  const hasNewResults = !!(
    project &&
    latest &&
    latest.revision > project.revision
  );

  const newProject = () => {
    const project: Project = {
      id: crypto.randomUUID(),
      name: "未命名项目",
      shots: [],
      aspect: "9:16",
      fit: "contain",
      burnCaptions: true,
      updatedAt: Date.now(),
      revision: 0,
    };
    setDrafts((current) => ({
      ...current,
      [project.id]: { project, dirty: true },
    }));
    setSelected(project.id);
  };
  const update = (change: Partial<Project>) => {
    if (!selected) return;
    setDrafts((current) => ({
      ...current,
      [selected]: {
        project: {
          ...current[selected].project,
          ...change,
          updatedAt: Date.now(),
        },
        base: current[selected].base ?? current[selected].project,
        dirty: true,
      },
    }));
  };
  const updateShot = (id: string, patch: Partial<Shot>) =>
    update({
      shots: project!.shots.map((shot) =>
        shot.id === id ? { ...shot, ...patch } : shot,
      ),
    });
  const save = async (): Promise<Project> => {
    if (!project) throw new Error("请选择一个项目。");
    if (!project.name.trim()) throw new Error("请先填写项目名称。");
    if (!draft.dirty && project.revision > 0) return project;
    const saved = await invoke<Project>("project.save", { project });
    setDrafts((current) => ({
      ...current,
      [saved.id]: { project: saved, base: saved, dirty: false },
    }));
    return saved;
  };
  const mergeResults = () => {
    if (!project || !latest) return;
    const shots = project.shots.map((shot) => {
      const remote = latest.shots.find((item) => item.id === shot.id);
      const base = draft.base?.shots.find((item) => item.id === shot.id);
      if (!remote) return shot;
      return {
        ...shot,
        jobId: remote.jobId,
        assetId: shot.assetId === base?.assetId ? remote.assetId : shot.assetId,
      };
    });
    const merged = {
      ...project,
      shots,
      revision: latest.revision,
      exportAssetId: latest.exportAssetId,
    };
    setDrafts((current) => ({
      ...current,
      [project.id]: { project: merged, base: latest, dirty: true },
    }));
  };
  const generate = (shotId?: string) =>
    run(`project.generate:${project!.id}`, async () => {
      const saved = await save();
      await invoke("project.generate", { id: saved.id, shotId });
      onNotice(shotId ? "镜头已加入生成队列。" : "分镜生成任务已加入队列。");
    });
  const exportProject = () =>
    run(`project.export:${project!.id}`, async () => {
      const saved = await save();
      await invoke("project.export", { id: saved.id });
    });
  const importShot = async (shotId: string) => {
    const asset = await run(`project.import:${shotId}`, () =>
      invoke<Asset | null>("media.pick", { kind: "any" }),
    );
    if (asset && asset.kind !== "audio")
      updateShot(shotId, { assetId: asset.id });
    else if (asset) onNotice("该文件是音频。请通过右侧音轨设置添加。");
  };
  const moveShot = (index: number, delta: number) => {
    const shots = [...project!.shots];
    [shots[index], shots[index + delta]] = [shots[index + delta], shots[index]];
    update({ shots });
  };
  const splitScript = () => {
    const parts = script
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) return;
    update({
      shots: [
        ...project!.shots,
        ...parts.map((prompt) => ({ ...blankShot(), prompt, caption: prompt })),
      ],
    });
    setScript("");
    setSplitOpen(false);
  };

  if (!project)
    return (
      <div>
        <div className="toolbar">
          <span className="muted">
            {list.length
              ? `${list.length} 个项目`
              : "把零散的镜头，连接成完整故事"}
          </span>
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={newProject}
          >
            新建项目
          </Button>
        </div>
        {list.length ? (
          <div className="project-grid">
            {list.map((item) => {
              const first = state.assets.find(
                (asset) =>
                  asset.id ===
                  item.project.shots.find((shot) => shot.assetId)?.assetId,
              );
              return (
                <button
                  className="project-card"
                  key={item.project.id}
                  onClick={() => setSelected(item.project.id)}
                >
                  <div className="project-cover">
                    {first ? (
                      <AssetThumb asset={first} />
                    ) : (
                      <Clapperboard size={34} strokeWidth={1.2} />
                    )}
                    <span>{item.project.aspect}</span>
                  </div>
                  <div className="project-card-body">
                    <h3>
                      {item.project.name || "未命名项目"}
                      {item.dirty && <small>未保存</small>}
                    </h3>
                    <p>
                      {item.project.shots.length} 个镜头 ·{" "}
                      {item.project.shots.reduce(
                        (sum, shot) => sum + shot.duration,
                        0,
                      )}{" "}
                      秒
                    </p>
                    <time>{formatDate(item.project.updatedAt)}</time>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="project-welcome card">
            <div className="project-illustration" aria-hidden="true">
              <div />
              <div />
              <div />
            </div>
            <h2>从分镜，到成片</h2>
            <p>逐个安排镜头，组合已有素材，配上字幕与音轨。</p>
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              onClick={newProject}
            >
              创建第一个项目
            </Button>
          </div>
        )}
      </div>
    );
  const pendingShots = project.shots.filter(
    (shot) =>
      !shot.assetId &&
      !state.jobs.some(
        (job) =>
          job.id === shot.jobId &&
          ["queued", "running", "needs_review"].includes(job.status),
      ),
  );
  const ready = state.muse.state === "ready" || state.muse.state === "busy";
  const missing = project.shots.filter(
    (shot) =>
      !state.assets.some(
        (asset) => asset.id === shot.assetId && asset.kind !== "audio",
      ),
  ).length;
  const output = state.assets.find(
    (asset) => asset.id === (exporting?.assetId ?? project.exportAssetId),
  );
  const audio = state.assets.find((asset) => asset.id === project.audioAssetId);
  const paragraphs = script
    .split(/\n\s*\n/)
    .filter((part) => part.trim()).length;

  return (
    <div className="project-workspace">
      <div className="project-toolbar">
        <div className="project-title">
          <IconButton label="返回项目列表" onClick={() => setSelected(null)}>
            <ArrowLeft size={20} />
          </IconButton>
          <input
            aria-label="项目名称"
            value={project.name}
            disabled={locked}
            maxLength={100}
            onChange={(event) => update({ name: event.target.value })}
          />
          <span className={`save-status ${draft.dirty ? "dirty" : ""}`}>
            {draft.dirty ? (
              "未保存"
            ) : (
              <>
                <Check size={13} />
                已保存
              </>
            )}
          </span>
        </div>
        <div className="button-group">
          <Button
            icon={<Save size={15} />}
            disabled={!draft.dirty || locked}
            loading={busy.has(`project.save:${project.id}`)}
            onClick={() => void run(`project.save:${project.id}`, save)}
          >
            保存
          </Button>
          <Button
            variant="primary"
            icon={<Sparkles size={15} />}
            disabled={
              !ready ||
              locked ||
              !pendingShots.length ||
              pendingShots.some((shot) => !shot.prompt.trim())
            }
            loading={busy.has(`project.generate:${project.id}`)}
            onClick={() => void generate()}
          >
            生成缺少素材的镜头
          </Button>
        </div>
      </div>
      {hasNewResults && (
        <div className="inline-info project-sync">
          <span>后台有新的生成结果。合并后可以继续保存当前编辑。</span>
          <Button onClick={mergeResults}>合并生成结果</Button>
          <button className="text-button" onClick={() => setReloadOpen(true)}>
            载入已保存版本
          </button>
        </div>
      )}
      <div className="project-editor-layout">
        <section className="shot-column">
          <div className="section-heading">
            <h2>
              镜头 <small>{project.shots.length}</small>
            </h2>
            <div className="button-group">
              <Button
                variant="ghost"
                icon={<ListPlus size={16} />}
                disabled={locked}
                onClick={() => setSplitOpen(true)}
              >
                按段落拆分
              </Button>
              <Button
                icon={<Plus size={16} />}
                disabled={locked || project.shots.length >= 30}
                onClick={() =>
                  update({ shots: [...project.shots, blankShot()] })
                }
              >
                添加镜头
              </Button>
            </div>
          </div>
          {!project.shots.length && (
            <div className="card">
              <EmptyState
                icon={<Film size={28} />}
                title="先添加一个镜头"
                action={
                  <Button
                    onClick={() => update({ shots: [blankShot()] })}
                    icon={<Plus size={15} />}
                  >
                    添加镜头
                  </Button>
                }
              >
                可以直接导入图片或视频，也可以写下画面描述交给 Muse 生成。
              </EmptyState>
            </div>
          )}
          <div className="shot-list">
            {project.shots.map((shot, index) => {
              const asset = state.assets.find(
                (item) => item.id === shot.assetId,
              );
              const job =
                state.jobs.find((item) => item.id === shot.jobId) ??
                state.jobs
                  .filter((item) => item.shotId === shot.id)
                  .sort((a, b) => b.createdAt - a.createdAt)[0];
              const generating =
                job?.status === "queued" || job?.status === "running";
              return (
                <article key={shot.id} className="shot-card card">
                  <div className="shot-heading">
                    <span className="shot-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <strong>镜头 {index + 1}</strong>
                    {job && <Status status={job.status} />}
                    <div className="shot-tools">
                      <IconButton
                        label="镜头上移"
                        disabled={locked || index === 0}
                        onClick={() => moveShot(index, -1)}
                      >
                        <ArrowUp size={15} />
                      </IconButton>
                      <IconButton
                        label="镜头下移"
                        disabled={locked || index === project.shots.length - 1}
                        onClick={() => moveShot(index, 1)}
                      >
                        <ArrowDown size={15} />
                      </IconButton>
                      <IconButton
                        label={`删除镜头 ${index + 1}`}
                        disabled={locked || generating}
                        onClick={() =>
                          update({
                            shots: project.shots.filter(
                              (item) => item.id !== shot.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </div>
                  <div className="shot-body">
                    <div className="shot-visual">
                      {asset ? (
                        <button
                          className="shot-preview"
                          onClick={() => onPreview(asset)}
                        >
                          <AssetThumb asset={asset} />
                        </button>
                      ) : (
                        <button
                          className="shot-placeholder"
                          disabled={locked}
                          onClick={() => setPicker({ shotId: shot.id })}
                        >
                          <ImageIcon size={23} />
                          <span>选择素材</span>
                        </button>
                      )}
                      <div className="shot-asset-actions">
                        <button
                          className="text-button"
                          disabled={locked}
                          onClick={() => setPicker({ shotId: shot.id })}
                        >
                          素材库
                        </button>
                        <button
                          className="text-button"
                          disabled={locked}
                          onClick={() => void importShot(shot.id)}
                        >
                          导入文件
                        </button>
                        {asset && (
                          <IconButton
                            label="取消镜头素材"
                            disabled={locked}
                            onClick={() =>
                              updateShot(shot.id, { assetId: undefined })
                            }
                          >
                            <X size={12} />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    <div className="shot-fields">
                      <label className="field">
                        <span>画面描述</span>
                        <textarea
                          rows={3}
                          maxLength={12000}
                          value={shot.prompt}
                          disabled={locked || generating}
                          onChange={(event) =>
                            updateShot(shot.id, { prompt: event.target.value })
                          }
                          placeholder="描述主体、场景与镜头运动…"
                        />
                      </label>
                      <label className="field compact">
                        <span>字幕</span>
                        <input
                          value={shot.caption}
                          maxLength={500}
                          disabled={locked}
                          onChange={(event) =>
                            updateShot(shot.id, { caption: event.target.value })
                          }
                          placeholder="这一镜头的字幕，可留空"
                        />
                      </label>
                      <div className="shot-bottom">
                        <label className="duration-field">
                          时长
                          <input
                            type="number"
                            min={1}
                            max={30}
                            step={0.5}
                            value={shot.duration}
                            disabled={locked}
                            onChange={(event) =>
                              updateShot(shot.id, {
                                duration: Number(event.target.value),
                              })
                            }
                          />
                          秒
                        </label>
                        <Button
                          variant="ghost"
                          icon={
                            generating ? (
                              <LoaderCircle size={14} className="spin" />
                            ) : (
                              <Sparkles size={14} />
                            )
                          }
                          disabled={
                            !ready ||
                            locked ||
                            generating ||
                            !shot.prompt.trim()
                          }
                          onClick={() => void generate(shot.id)}
                        >
                          {generating
                            ? "生成中"
                            : asset
                              ? "重新生成"
                              : "生成这一镜"}
                        </Button>
                      </div>
                    </div>
                  </div>
                  {job?.error && <p className="shot-error">{job.error}</p>}
                </article>
              );
            })}
          </div>
        </section>
        <aside className="export-panel card">
          <h2>成片设置</h2>
          <div className="field">
            <span>画幅比例</span>
            <div className="aspect-options">
              {(["9:16", "16:9", "1:1"] as const).map((aspect) => (
                <button
                  disabled={locked}
                  key={aspect}
                  aria-pressed={project.aspect === aspect}
                  className={project.aspect === aspect ? "active" : ""}
                  onClick={() => update({ aspect })}
                >
                  <span
                    style={{
                      aspectRatio: aspect.replace(":", "/"),
                      width: aspect === "9:16" ? 13 : 22,
                    }}
                  />
                  {aspect}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>素材适配</span>
            <select
              value={project.fit}
              disabled={locked}
              onChange={(event) =>
                update({ fit: event.target.value as Project["fit"] })
              }
            >
              <option value="contain">完整显示，留空边</option>
              <option value="cover">填满画面，裁切边缘</option>
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={project.burnCaptions}
              disabled={locked}
              onChange={(event) =>
                update({ burnCaptions: event.target.checked })
              }
            />
            <span>
              <strong>将字幕写入画面</strong>
              <small>使用每个镜头填写的字幕</small>
            </span>
          </label>
          <div className="audio-field">
            <div className="field-heading">
              <span>音轨</span>
              {audio && (
                <IconButton
                  label="移除音轨"
                  disabled={locked}
                  onClick={() => update({ audioAssetId: undefined })}
                >
                  <X size={14} />
                </IconButton>
              )}
            </div>
            {audio ? (
              <button
                className="selected-audio"
                onClick={() => onPreview(audio)}
              >
                <Music2 size={17} />
                <span>{audio.name}</span>
              </button>
            ) : (
              <p className="field-hint">
                添加音轨将替换原视频声音；未添加时保留原声。
              </p>
            )}
            <div className="button-group">
              <Button
                icon={<Upload size={14} />}
                disabled={locked}
                onClick={() =>
                  void run("project.audio", async () => {
                    const asset = await invoke<Asset | null>("media.pick", {
                      kind: "audio",
                    });
                    if (asset) update({ audioAssetId: asset.id });
                  })
                }
              >
                导入
              </Button>
              <Button
                variant="ghost"
                disabled={locked}
                onClick={() => setPicker({ audio: true })}
              >
                素材库
              </Button>
            </div>
          </div>
          <div className="export-summary">
            <div>
              <span>镜头数量</span>
              <strong>{project.shots.length}</strong>
            </div>
            <div>
              <span>预计时长</span>
              <strong>
                {project.shots.reduce((sum, shot) => sum + shot.duration, 0)} 秒
              </strong>
            </div>
          </div>
          {missing > 0 && (
            <p className="field-hint warning">
              还有 {missing} 个镜头缺少素材。
            </p>
          )}
          {exporting?.state === "rendering" && (
            <div className="export-progress">
              <div>
                <span>
                  {exporting.progress === 0
                    ? "正在准备合成工具"
                    : "正在合成视频"}
                </span>
                <strong>{Math.round(exporting.progress)}%</strong>
              </div>
              <progress max={100} value={exporting.progress} />
              {exporting.progress === 0 && (
                <p className="field-hint">
                  首次使用会自动下载合成工具，请稍候。
                </p>
              )}
            </div>
          )}
          {exporting?.state === "failed" && (
            <p className="inline-error">
              {exporting.error || "导出失败，请重试。"}
            </p>
          )}
          <Button
            variant="primary"
            className="full-width"
            icon={<Download size={16} />}
            disabled={
              locked ||
              !project.shots.length ||
              missing > 0 ||
              project.shots.some(
                (shot) => shot.duration < 1 || shot.duration > 30,
              ) ||
              exporting?.state === "rendering"
            }
            loading={busy.has(`project.export:${project.id}`)}
            onClick={() => void exportProject()}
          >
            导出成片
          </Button>
          {output && (
            <Button
              className="full-width"
              icon={<Film size={15} />}
              onClick={() => onPreview(output)}
            >
              预览最近导出的成片
            </Button>
          )}
          <p className="field-hint">
            生成和导出前会保存项目，并输出 MP4 和独立 SRT
            字幕。编辑内容在切换页面时保留，关闭应用前请保存。
          </p>
          <button
            className="text-button danger-text"
            disabled={locked}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={13} />
            删除项目
          </button>
        </aside>
      </div>
      {picker && (
        <MediaPicker
          assets={state.assets}
          kind={picker.audio ? "audio" : "visual"}
          onClose={closePicker}
          onSelect={(asset) =>
            picker.audio
              ? update({ audioAssetId: asset.id })
              : updateShot(picker.shotId!, { assetId: asset.id })
          }
        />
      )}
      {splitOpen && (
        <Modal title="按段落拆分为镜头" onClose={closeSplit}>
          <p className="modal-description">
            每个空行分隔的段落会成为一个镜头，并填入画面描述和字幕。拆分后可以分别编辑。
          </p>
          <textarea
            className="script-input"
            rows={10}
            value={script}
            onChange={(event) => setScript(event.target.value)}
            placeholder={
              "第一个镜头的描述\n\n第二个镜头的描述\n\n第三个镜头的描述"
            }
          />
          <div className="modal-footer">
            <span className="muted">
              将追加 {paragraphs} 个镜头 · 每个项目最多 30 个
            </span>
            <Button
              variant="primary"
              disabled={!paragraphs || project.shots.length + paragraphs > 30}
              onClick={splitScript}
            >
              添加到分镜
            </Button>
          </div>
        </Modal>
      )}
      {reloadOpen && latest && (
        <Modal title="载入已保存版本？" onClose={closeReload}>
          <p className="modal-description">
            当前未保存的修改会被已保存的项目替换。需要保留修改时，请返回并选择合并生成结果。
          </p>
          <div className="modal-footer">
            <Button onClick={closeReload}>保留当前编辑</Button>
            <Button
              variant="primary"
              onClick={() => {
                setDrafts((current) => ({
                  ...current,
                  [latest.id]: { project: latest, base: latest, dirty: false },
                }));
                setReloadOpen(false);
              }}
            >
              载入已保存版本
            </Button>
          </div>
        </Modal>
      )}
      {deleteOpen && (
        <Modal title="删除这个项目？" onClose={closeDelete}>
          <p className="modal-description">
            “{project.name}”的分镜安排将被删除，素材库中的文件仍可使用。
          </p>
          <div className="modal-footer">
            <Button onClick={closeDelete}>保留项目</Button>
            <Button
              variant="danger"
              loading={busy.has(`project.delete:${project.id}`)}
              onClick={() =>
                void run(`project.delete:${project.id}`, async () => {
                  if (project.revision > 0)
                    await invoke("project.delete", { id: project.id });
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[project.id];
                    return next;
                  });
                  setSelected(null);
                  setDeleteOpen(false);
                })
              }
            >
              删除项目
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
