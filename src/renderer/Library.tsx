import { useState } from "react";
import {
  Film,
  FolderOpen,
  ImageIcon,
  Music2,
  Plus,
  Search,
} from "lucide-react";
import type { AppState, Asset } from "../shared/types";
import {
  AssetThumb,
  Button,
  EmptyState,
  formatDate,
  invoke,
  type Run,
} from "./ui";

export function Library({
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
  const [search, setSearch] = useState("");
  const filters = [
    { id: "all", label: "全部" },
    { id: "video", label: "视频" },
    { id: "image", label: "图片" },
    { id: "audio", label: "音频" },
  ];
  const assets = [...state.assets]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(
      (asset) =>
        (filter === "all" || asset.kind === filter) &&
        asset.name.toLowerCase().includes(search.toLowerCase()),
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
        <div className="toolbar-actions">
          <div className="search-field">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索素材"
              placeholder="搜索素材名称"
            />
          </div>
          <Button
            icon={<Plus size={16} />}
            loading={busy.has("library.import")}
            onClick={() =>
              void run("library.import", () =>
                invoke("media.pick", { kind: "any" }),
              )
            }
          >
            导入素材
          </Button>
        </div>
      </div>
      {assets.length ? (
        <div className="library-grid">
          {assets.map((asset) => (
            <article className="media-card" key={asset.id}>
              <button
                className="media-preview"
                onClick={() => onPreview(asset)}
                aria-label={`预览 ${asset.name}`}
              >
                <AssetThumb asset={asset} />
                <span className="media-kind">
                  {asset.kind === "video" ? (
                    <Film size={13} />
                  ) : asset.kind === "image" ? (
                    <ImageIcon size={13} />
                  ) : (
                    <Music2 size={13} />
                  )}
                  {asset.kind === "video"
                    ? "视频"
                    : asset.kind === "image"
                      ? "图片"
                      : "音频"}
                </span>
              </button>
              <div className="media-info">
                <h3 title={asset.name}>{asset.name}</h3>
                <div>
                  <time>{formatDate(asset.createdAt)}</time>
                  <button
                    className="text-button"
                    aria-label={`显示 ${asset.name} 的文件位置`}
                    onClick={() =>
                      void run(`reveal:${asset.id}`, () =>
                        invoke("media.reveal", { id: asset.id }),
                      )
                    }
                  >
                    <FolderOpen size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={<FolderOpen size={30} />}
            title={
              search || filter !== "all"
                ? "没有找到素材"
                : "为你的下一条视频准备素材"
            }
            action={
              <div className="button-group">
                <Button variant="primary" onClick={onCreate}>
                  生成素材
                </Button>
                <Button
                  onClick={() =>
                    void run("library.import", () =>
                      invoke("media.pick", { kind: "any" }),
                    )
                  }
                >
                  从电脑导入
                </Button>
              </div>
            }
          >
            生成结果和导入的文件都保存在本机，可以随时用于分镜项目。
          </EmptyState>
        </div>
      )}
    </div>
  );
}
