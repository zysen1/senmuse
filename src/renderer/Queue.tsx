import { useState } from "react";
import {
  ArrowUpRight,
  Clock3,
  Layers3,
  Pause,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import type { AppState, Asset, Job } from "../shared/types";
import {
  AssetThumb,
  Button,
  EmptyState,
  Status,
  formatDate,
  invoke,
  kindLabels,
  type Run,
} from "./ui";

export function Queue({
  state,
  run,
  busy,
  onPreview,
  onCreate,
}: {
  state: AppState;
  run: Run;
  busy: Set<string>;
  onPreview: (asset: Asset) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const filters = [
    { id: "all", label: "全部" },
    { id: "active", label: "进行中" },
    { id: "completed", label: "已完成" },
    { id: "attention", label: "需要处理" },
  ];
  const jobs = [...state.jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(
      (job) =>
        filter === "all" ||
        (filter === "active" && ["queued", "running"].includes(job.status)) ||
        (filter === "completed" && job.status === "completed") ||
        (filter === "attention" &&
          ["failed", "needs_review"].includes(job.status)),
    );
  return (
    <div>
      <div className="toolbar">
        <div className="filter-tabs">
          {filters.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Button
          icon={state.queuePaused ? <Play size={15} /> : <Pause size={15} />}
          loading={busy.has("queue.pause")}
          onClick={() =>
            void run("queue.pause", () =>
              invoke("queue.pause", { paused: !state.queuePaused }),
            )
          }
        >
          {state.queuePaused ? "继续队列" : "暂停队列"}
        </Button>
      </div>
      {state.queuePaused && (
        <div className="inline-info">
          <Pause size={16} />
          队列已暂停。重试后任务会排队，点击“继续队列”才会开始。当前运行中的任务会继续。
        </div>
      )}
      {jobs.length ? (
        <div className="job-list">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              state={state}
              run={run}
              busy={busy}
              onPreview={onPreview}
            />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={<Layers3 size={30} />}
            title={filter === "all" ? "还没有创作任务" : "没有符合条件的任务"}
            action={
              filter === "all" ? (
                <Button variant="primary" onClick={onCreate}>
                  开始创作
                </Button>
              ) : undefined
            }
          >
            你提交的任务及其生成状态会保存在这里。
          </EmptyState>
        </div>
      )}
    </div>
  );
}
function JobRow({
  job,
  state,
  run,
  busy,
  onPreview,
}: {
  job: Job;
  state: AppState;
  run: Run;
  busy: Set<string>;
  onPreview: (asset: Asset) => void;
}) {
  const assets = state.assets.filter((asset) =>
    job.assetIds.includes(asset.id),
  );
  const canCancel = ["queued", "running", "needs_review"].includes(job.status);
  const linkedShot = state.projects
    .find((project) => project.id === job.projectId)
    ?.shots.find((shot) => shot.id === job.shotId);
  const projectChanged = !!job.projectId && linkedShot?.jobId !== job.id;
  const canRetry =
    !projectChanged &&
    ["failed", "cancelled", "needs_review"].includes(job.status);
  const [confirmRetry, setConfirmRetry] = useState(false);
  return (
    <article className="job-row card">
      <div className="job-symbol">
        {assets[0] ? (
          <button className="thumb-button" onClick={() => onPreview(assets[0])}>
            <AssetThumb asset={assets[0]} />
          </button>
        ) : (
          <Clock3 size={22} />
        )}
      </div>
      <div className="job-main">
        <div className="job-heading">
          <span className="kind-label">{kindLabels[job.kind]}</span>
          <Status status={job.status} />
          <time>{formatDate(job.createdAt)}</time>
        </div>
        <p className="job-prompt">{job.prompt}</p>
        <p className="job-progress">{job.progress}</p>
        {job.error && <p className="inline-error">{job.error}</p>}
        {job.status === "needs_review" && (
          <p className="field-hint">
            结束跟踪后可继续编辑项目，Muse 中的生成可能仍在进行。
          </p>
        )}
        {projectChanged &&
          ["failed", "cancelled", "needs_review"].includes(job.status) && (
            <p className="field-hint">
              原镜头已更新或移除，需要新画面时请在分镜项目中重新生成。
            </p>
          )}
        {assets.length > 1 && (
          <div className="job-results">
            {assets.map((asset, index) => (
              <button
                className="text-button"
                key={asset.id}
                onClick={() => onPreview(asset)}
              >
                预览结果 {index + 1}
              </button>
            ))}
          </div>
        )}
        {confirmRetry && (
          <div className="review-confirm">
            <p>请先在 Muse 中检查这次任务。重新提交可能再次消耗额度。</p>
            <div>
              <Button
                variant="primary"
                loading={busy.has(`retry:${job.id}`)}
                onClick={() =>
                  void run(`retry:${job.id}`, async () => {
                    await invoke("job.retry", { id: job.id });
                    setConfirmRetry(false);
                  })
                }
              >
                确认重新提交
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRetry(false)}>
                返回
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="job-actions">
        {assets.length > 0 && (
          <Button
            onClick={() => onPreview(assets[0])}
            icon={<Play size={14} />}
          >
            预览
          </Button>
        )}
        {job.conversationUrl && (
          <Button
            variant="ghost"
            icon={<ArrowUpRight size={14} />}
            onClick={() =>
              void run(`conversation:${job.id}`, () =>
                invoke("app.openExternal", { url: job.conversationUrl }),
              )
            }
          >
            对话
          </Button>
        )}
        {canCancel && (
          <Button
            variant="ghost"
            loading={busy.has(`cancel:${job.id}`)}
            icon={<Square size={13} />}
            onClick={() =>
              void run(`cancel:${job.id}`, async () => {
                await invoke("job.cancel", { id: job.id });
                setConfirmRetry(false);
              })
            }
          >
            {job.status === "needs_review" ? "结束跟踪" : "取消"}
          </Button>
        )}
        {canRetry && (
          <Button
            icon={<RefreshCw size={14} />}
            loading={busy.has(`retry:${job.id}`)}
            onClick={() =>
              job.status === "needs_review" || !!job.submittedAt
                ? setConfirmRetry(true)
                : void run(`retry:${job.id}`, () =>
                    invoke("job.retry", { id: job.id }),
                  )
            }
          >
            重试
          </Button>
        )}
      </div>
    </article>
  );
}
