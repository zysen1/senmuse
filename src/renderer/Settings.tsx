import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  LogOut,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import type { AppState, Settings as SettingsData } from "../shared/types";
import { Button, invoke, type Run } from "./ui";

export function Settings({
  state,
  run,
  busy,
  onNotice,
}: {
  state: AppState;
  run: Run;
  busy: Set<string>;
  onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState<SettingsData>(state.settings);
  const [dirty, setDirty] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(state.settings);
  }, [state.settings, dirty]);
  const update = (patch: Partial<SettingsData>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const save = () =>
    run("settings.save", async () => {
      await invoke("settings.save", draft);
      setDirty(false);
      onNotice("设置已保存。");
    });
  const ready = state.muse.state === "ready" || state.muse.state === "busy";
  const port = state.api.port || draft.apiPort;
  const copy = (value: string, label: string) =>
    run("clipboard", async () => {
      await navigator.clipboard.writeText(value);
      onNotice(`${label}已复制。`);
    });
  const copyMcp = () =>
    run("api.mcp", async () => {
      const info = await invoke<{ mcpScript: string; nodeCommand: string }>(
        "app.info",
      );
      const apiToken = token ?? (await invoke<string>("api.token"));
      const config = {
        mcpServers: {
          senmuse: {
            command: info.nodeCommand,
            args: [info.mcpScript],
            env: {
              SENMUSE_API_URL: `http://127.0.0.1:${port}`,
              SENMUSE_API_TOKEN: apiToken,
            },
          },
        },
      };
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      onNotice(
        "MCP 配置已复制，包含本地 API 密钥。请粘贴到你的 AI 工具配置中。",
      );
    });
  const apiExample = token
    ? `curl -X POST http://127.0.0.1:${port}/v1/jobs \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"kind":"video","prompt":"清晨咖啡馆，镜头缓慢推进","requestId":"senmuse-example-001"}'`
    : "";
  return (
    <div className="settings-layout">
      <div className="settings-main">
        <section className="settings-card card">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <Wifi size={20} />
            </span>
            <div>
              <h2>Muse 连接</h2>
              <p>在独立窗口中登录，登录状态保存在本机。</p>
            </div>
            <span className={`connection-inline ${ready ? "" : "muted"}`}>
              <span className={`connection-dot ${ready ? "ready" : ""}`} />
              {ready ? "已连接" : "待连接"}
            </span>
          </div>
          <div
            className={`connection-detail ${state.muse.state === "error" ? "error-text" : ""}`}
          >
            {state.muse.message || "打开 Muse 窗口，完成账号登录后检查连接。"}
          </div>
          <div className="button-group">
            <Button
              variant="primary"
              icon={<ArrowUpRight size={15} />}
              loading={busy.has("muse.open")}
              onClick={() => void run("muse.open", () => invoke("muse.open"))}
            >
              打开 Muse
            </Button>
            <Button
              icon={<RefreshCw size={15} />}
              loading={busy.has("muse.inspect")}
              onClick={() =>
                void run("muse.inspect", () => invoke("muse.inspect"))
              }
            >
              检查连接
            </Button>
          </div>
          <div className="settings-divider" />
          <label className="field">
            <span>
              自定义代理 <small>可选</small>
            </span>
            <input
              value={draft.proxy}
              onChange={(event) => update({ proxy: event.target.value })}
              placeholder="例如 http://127.0.0.1:7890"
              spellCheck={false}
            />
            <span className="field-hint">
              留空时使用系统网络设置。修改后点击下方“保存设置”。
            </span>
          </label>
        </section>
        <section className="settings-card card">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <FolderOpen size={20} />
            </span>
            <div>
              <h2>文件保存</h2>
              <p>导出成片的保存位置。</p>
            </div>
          </div>
          <label className="field">
            <span>输出文件夹</span>
            <div className="folder-input">
              <input
                value={draft.outputDir}
                onChange={(event) => update({ outputDir: event.target.value })}
                spellCheck={false}
              />
              <Button
                icon={<FolderOpen size={15} />}
                loading={busy.has("settings.pickDirectory")}
                onClick={() =>
                  void run("settings.pickDirectory", async () => {
                    const directory = await invoke<string | null>(
                      "settings.pickDirectory",
                    );
                    if (directory) update({ outputDir: directory });
                  })
                }
              >
                选择
              </Button>
            </div>
          </label>
        </section>
        <section className="settings-card card">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <Server size={20} />
            </span>
            <div>
              <h2>AI 工具接入</h2>
              <p>让本机的 Claude、Codex 或脚本通过 HTTP 调用森映。</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                aria-label="启用本地 API"
                checked={draft.apiEnabled}
                onChange={(event) =>
                  update({ apiEnabled: event.target.checked })
                }
              />
              <span />
            </label>
          </div>
          {draft.apiEnabled && (
            <>
              <div className="mcp-connect">
                <Button
                  icon={<Copy size={14} />}
                  loading={busy.has("api.mcp")}
                  onClick={() => void copyMcp()}
                >
                  复制 MCP 配置
                </Button>
                <p className="field-hint">
                  适用于支持 stdio MCP 的工具。配置包含密钥，需要本机已安装
                  Node.js。
                </p>
              </div>
              <label className="field port-field">
                <span>本地端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={draft.apiPort}
                  onChange={(event) =>
                    update({ apiPort: Number(event.target.value) })
                  }
                />
              </label>
              <div className="api-status">
                <span
                  className={`connection-dot ${state.api.running ? "ready" : ""}`}
                />
                <span>
                  {state.api.running
                    ? `服务正在 127.0.0.1:${state.api.port} 运行`
                    : "服务尚未启动，保存设置后启用"}
                </span>
              </div>
              {state.api.error && (
                <p className="inline-error">{state.api.error}</p>
              )}
              <div className="settings-divider" />
              <div className="field-heading">
                <span>API 密钥</span>
                <Button
                  variant="ghost"
                  icon={<KeyRound size={14} />}
                  loading={busy.has("api.token")}
                  onClick={() =>
                    void run("api.token", async () => {
                      const value = await invoke<string>("api.token");
                      setToken(value);
                      setShowToken(true);
                    })
                  }
                >
                  {token ? "重新读取" : "显示密钥"}
                </Button>
              </div>
              {token ? (
                <>
                  <div className="token-field">
                    <code>
                      {showToken ? token : "••••••••••••••••••••••••••••"}
                    </code>
                    <Button
                      variant="ghost"
                      aria-label={showToken ? "隐藏密钥" : "显示密钥"}
                      onClick={() => setShowToken((value) => !value)}
                      icon={
                        showToken ? <EyeOff size={15} /> : <Eye size={15} />
                      }
                    />
                    <Button
                      variant="ghost"
                      icon={<Copy size={15} />}
                      onClick={() => void copy(token, "密钥")}
                    >
                      复制
                    </Button>
                  </div>
                  <Button
                    icon={<Copy size={14} />}
                    onClick={() => void copy(apiExample, "调用示例")}
                  >
                    复制 curl 调用示例
                  </Button>
                  <p className="field-hint">
                    示例中的 requestId
                    用于避免重复提交。需要生成新任务时请更换它。
                  </p>
                </>
              ) : (
                <p className="field-hint">
                  需要接入时再显示密钥，密钥用于验证本机 API 请求。
                </p>
              )}
            </>
          )}
        </section>
        <div className="settings-save">
          <span className="muted">
            {dirty ? "有尚未保存的设置" : "设置已保存"}
          </span>
          <Button
            variant="primary"
            icon={<Save size={16} />}
            disabled={
              !dirty ||
              !draft.outputDir.trim() ||
              (draft.apiEnabled &&
                (!Number.isInteger(draft.apiPort) ||
                  draft.apiPort < 1024 ||
                  draft.apiPort > 65535))
            }
            loading={busy.has("settings.save")}
            onClick={() => void save()}
          >
            保存设置
          </Button>
        </div>
      </div>
      <aside className="settings-aside">
        <div className="about-card">
          <span className="about-name">
            森映 <small>SenMuse</small>
          </span>
          <p>中文 Muse 创作与分镜成片工作台。</p>
          <span className="version">版本 {state.version}</span>
          <div className="settings-divider" />
          <div className="about-detail">
            <ShieldCheck size={17} />
            <span>项目和素材保存在本机</span>
          </div>
          <div className="about-detail">
            <Settings2 size={17} />
            <span>Muse 生成需要有效的登录与可用额度</span>
          </div>
          <p className="field-hint">森映是独立项目，连接 Muse 网页完成生成。</p>
          <Button
            variant="ghost"
            icon={<LogOut size={15} />}
            onClick={() => void run("app.quit", () => invoke("app.quit"))}
          >
            退出森映
          </Button>
        </div>
      </aside>
    </div>
  );
}
