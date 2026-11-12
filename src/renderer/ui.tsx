import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  FolderOpen,
  ImageIcon,
  LoaderCircle,
  Music2,
  Play,
  X,
} from "lucide-react";
import type { Asset, JobKind, JobStatus } from "../shared/types";

export type Run = <T>(
  key: string,
  operation: () => Promise<T>,
) => Promise<T | undefined>;
export const invoke = <T,>(command: string, input?: unknown) =>
  window.senmuse.invoke<T>(command, input);
export const kindLabels: Record<JobKind, string> = {
  video: "生成视频",
  image: "生成图片",
  edit: "修改视频",
  extend: "续拍视频",
};
export const statusLabels: Record<JobStatus, string> = {
  queued: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  needs_review: "需要检查",
};
export const formatDate = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);

export function Button({
  children,
  variant = "secondary",
  loading,
  icon,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      disabled={props.disabled || loading}
      className={`button ${variant} ${className}`}
    >
      {loading ? <LoaderCircle size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      type="button"
      className={`icon-button ${props.className ?? ""}`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Status({ status }: { status: JobStatus }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}
export function AssetThumb({
  asset,
  className = "",
}: {
  asset: Asset;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id, asset.url]);
  return (
    <div className={`asset-thumb ${className}`}>
      {failed ? (
        <span className="media-unavailable">
          <AlertCircle size={18} />
          预览不可用
        </span>
      ) : asset.kind === "image" ? (
        <img
          src={asset.url}
          alt={asset.name}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : asset.kind === "video" ? (
        <>
          <video
            src={asset.url}
            muted
            preload="metadata"
            onError={() => setFailed(true)}
          />
          <span className="play-mark">
            <Play size={16} fill="currentColor" />
          </span>
        </>
      ) : (
        <Music2 size={24} />
      )}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const list = ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]',
      );
      if (!list?.length) return;
      const first = list[0],
        last = list[list.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
export function AssetPreview({
  asset,
  onClose,
  run,
}: {
  asset: Asset;
  onClose: () => void;
  run: Run;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Modal title={asset.name} onClose={onClose} wide>
      <div className="preview-media">
        {asset.kind === "image" ? (
          <img
            src={asset.url}
            alt={asset.name}
            onError={() => setFailed(true)}
          />
        ) : asset.kind === "video" ? (
          <video
            src={asset.url}
            controls
            autoPlay
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="audio-preview">
            <Music2 size={48} />
            <audio
              src={asset.url}
              controls
              autoPlay
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      {failed && (
        <p className="inline-error">
          当前文件无法预览，可能已被移动或编码不支持。可以打开文件位置查看原文件。
        </p>
      )}
      <div className="modal-footer">
        <span className="muted">{formatDate(asset.createdAt)}</span>
        <Button
          icon={<FolderOpen size={16} />}
          onClick={() =>
            void run("reveal", () => invoke("media.reveal", { id: asset.id }))
          }
        >
          在文件夹中显示
        </Button>
      </div>
    </Modal>
  );
}
export function Notice({
  message,
  error,
  onClose,
}: {
  message: string;
  error?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? <AlertCircle size={18} /> : <Check size={18} />}
      <span>{message}</span>
      <IconButton label="关闭提示" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
export function MediaPicker({
  assets,
  kind,
  onSelect,
  onClose,
}: {
  assets: Asset[];
  kind: "visual" | "audio";
  onSelect: (asset: Asset) => void;
  onClose: () => void;
}) {
  const available = assets.filter((asset) =>
    kind === "audio" ? asset.kind === "audio" : asset.kind !== "audio",
  );
  return (
    <Modal
      title={kind === "audio" ? "选择音轨" : "选择镜头素材"}
      onClose={onClose}
      wide
    >
      {available.length ? (
        <div className="picker-grid">
          {available.map((asset) => (
            <button
              key={asset.id}
              className="picker-card"
              onClick={() => {
                onSelect(asset);
                onClose();
              }}
            >
              <AssetThumb asset={asset} />
              <span>{asset.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState icon={<ImageIcon size={28} />} title="暂无可选素材">
          先在素材库导入文件，或生成一段视频。
        </EmptyState>
      )}
    </Modal>
  );
}
