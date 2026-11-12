import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Clapperboard,
  FolderOpen,
  Layers3,
  Leaf,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  Sparkles,
  WifiOff,
} from "lucide-react";
import type { AppState, Asset, Project } from "../shared/types";
import {
  AssetPreview,
  Button,
  IconButton,
  Notice,
  invoke,
  type Run,
} from "./ui";
import { Studio, type StudioDraft } from "./Studio";
import { Projects, type ProjectDraft } from "./Projects";
import { Queue } from "./Queue";
import { Library } from "./Library";
import { Settings } from "./Settings";

type Page = "studio" | "projects" | "queue" | "library" | "settings";
const navigation = [
  {
    id: "studio",
    title: "创作台",
    icon: Sparkles,
    description: "从一句描述开始，生成你的图片和视频。",
  },
  {
    id: "projects",
    title: "分镜成片",
    icon: Clapperboard,
    description: "安排镜头、添加字幕与音轨，合成完整视频。",
  },
  {
    id: "queue",
    title: "任务队列",
    icon: Layers3,
    description: "查看生成进度，处理失败和需要检查的任务。",
  },
  {
    id: "library",
    title: "素材库",
    icon: FolderOpen,
    description: "你生成和导入的图片、视频与音频。",
  },
  {
    id: "settings",
    title: "设置",
    icon: Settings2,
    description: "管理 Muse 连接、文件保存和 AI 工具接入。",
  },
] as const;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const eventVersion = useRef(0);
  const [connectionError, setConnectionError] = useState("");
  const [page, setPage] = useState<Page>("studio");
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const [preview, setPreview] = useState<Asset | null>(null);
  const [studio, setStudio] = useState<StudioDraft>({
    kind: "video",
    prompt: "",
    referenceIds: [],
    requestId: crypto.randomUUID(),
  });
  const [drafts, setDrafts] = useState<Record<string, ProjectDraft>>({});
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const applyState = useCallback((next: AppState) => {
    setState(next);
    setConnectionError("");
    setDrafts((previous) => {
      const copy = { ...previous };
      for (const project of next.projects) {
        if (!copy[project.id]?.dirty)
          copy[project.id] = { project, base: project, dirty: false };
      }
      for (const [id, draft] of Object.entries(copy)) {
        if (!draft.dirty && !next.projects.some((project) => project.id === id))
          delete copy[id];
      }
      return copy;
    });
  }, []);

  const connect = useCallback(async () => {
    try {
      if (!window.senmuse)
        throw new Error("桌面服务尚未连接。请通过森映桌面应用打开此界面。");
      const version = eventVersion.current;
      const snapshot = await invoke<AppState>("state.get");
      if (version === eventVersion.current) applyState(snapshot);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }, [applyState]);

  useEffect(() => {
    const off = window.senmuse?.onState((next) => {
      eventVersion.current++;
      applyState(next);
    });
    void connect();
    return off;
  }, [applyState, connect]);

  const run: Run = useCallback(
    async <T,>(
      key: string,
      operation: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (busyRef.current.has(key)) return undefined;
      busyRef.current.add(key);
      setBusy(new Set(busyRef.current));
      setError("");
      try {
        return await operation();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        busyRef.current.delete(key);
        setBusy(new Set(busyRef.current));
      }
    },
    [],
  );

  const closePreview = useCallback(() => setPreview(null), []);
  if (!state)
    return (
      <div className="boot-screen">
        <Leaf size={36} />
        <h1>
          森映 <span>SenMuse</span>
        </h1>
        {connectionError ? (
          <>
            <WifiOff size={28} />
            <p role="alert">{connectionError}</p>
            <Button
              onClick={() => void connect()}
              icon={<RefreshCw size={16} />}
            >
              重新连接
            </Button>
          </>
        ) : (
          <>
            <LoaderCircle size={24} className="spin" />
            <p>正在打开创作空间…</p>
          </>
        )}
      </div>
    );
  const current = navigation.find((item) => item.id === page)!;
  const pending = state.jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  ).length;
  const ready = state.muse.state === "ready" || state.muse.state === "busy";

  return (
    <div className={`app ${collapsed ? "nav-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="window-drag" />
        <button
          className="brand"
          onClick={() => setPage("studio")}
          aria-label="森映创作台"
        >
          <span className="brand-mark">
            <Leaf size={25} strokeWidth={1.65} />
          </span>
          <span className="brand-text">
            森映<span>SenMuse</span>
          </span>
        </button>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
              title={item.title}
            >
              <item.icon size={19} strokeWidth={1.8} />
              <span>{item.title}</span>
              {item.id === "queue" && pending > 0 && <small>{pending}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="connection-card"
            onClick={() => setPage("settings")}
            title={state.muse.message}
          >
            <span className={`connection-dot ${ready ? "ready" : ""}`} />
            <span>
              <strong>Muse {ready ? "已连接" : "待连接"}</strong>
              <small>{ready ? "本地创作空间" : "登录后开始生成"}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
          <div className="sidebar-footer">
            <span>v{state.version}</span>
            <IconButton
              label={collapsed ? "展开导航" : "收起导航"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? (
                <PanelLeftOpen size={17} />
              ) : (
                <PanelLeftClose size={17} />
              )}
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="page-header">
          <div>
            <div className="page-eyebrow">森映工作空间</div>
            <h1>{current.title}</h1>
            <p>{current.description}</p>
          </div>
          <div className="header-action">
            {!ready && (
              <Button
                icon={<ArrowUpRight size={16} />}
                loading={busy.has("muse.open")}
                onClick={() => void run("muse.open", () => invoke("muse.open"))}
              >
                登录 Muse
              </Button>
            )}
            {ready && (
              <span className="connection-inline">
                <span className="connection-dot ready" />
                Muse 已连接
              </span>
            )}
          </div>
        </header>
        <div className="message-stack">
          {connectionError && (
            <Notice
              error
              message={connectionError}
              onClose={() => setConnectionError("")}
            />
          )}
          {error && (
            <Notice error message={error} onClose={() => setError("")} />
          )}
          {notice && <Notice message={notice} onClose={() => setNotice("")} />}
        </div>
        <div className="page-content">
          {page === "studio" && (
            <Studio
              state={state}
              draft={studio}
              setDraft={setStudio}
              run={run}
              busy={busy}
              onPreview={setPreview}
              onQueue={() => setPage("queue")}
              onNotice={setNotice}
            />
          )}
          {page === "projects" && (
            <Projects
              state={state}
              drafts={drafts}
              setDrafts={setDrafts}
              selected={selectedProject}
              setSelected={setSelectedProject}
              run={run}
              busy={busy}
              onPreview={setPreview}
              onNotice={setNotice}
            />
          )}
          {page === "queue" && (
            <Queue
              state={state}
              run={run}
              busy={busy}
              onPreview={setPreview}
              onCreate={() => setPage("studio")}
            />
          )}
          {page === "library" && (
            <Library
              state={state}
              run={run}
              busy={busy}
              onPreview={setPreview}
              onCreate={() => setPage("studio")}
            />
          )}
          {page === "settings" && (
            <Settings
              state={state}
              run={run}
              busy={busy}
              onNotice={setNotice}
            />
          )}
        </div>
      </main>
      {preview && (
        <AssetPreview asset={preview} onClose={closePreview} run={run} />
      )}
    </div>
  );
}
