export type JobKind = "video" | "image" | "edit" | "extend";
export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_review";
export interface Asset {
  id: string;
  name: string;
  kind: "image" | "video" | "audio";
  path: string;
  url: string;
  createdAt: number;
  jobId?: string;
}
export interface Job {
  id: string;
  kind: JobKind;
  prompt: string;
  referenceIds: string[];
  status: JobStatus;
  progress: string;
  createdAt: number;
  updatedAt: number;
  assetIds: string[];
  error?: string;
  conversationUrl?: string;
  submittedAt?: number;
  projectId?: string;
  shotId?: string;
}
export interface Shot {
  id: string;
  prompt: string;
  caption: string;
  duration: number;
  assetId?: string;
  jobId?: string;
}
export interface Project {
  id: string;
  name: string;
  shots: Shot[];
  aspect: "9:16" | "16:9" | "1:1";
  fit: "contain" | "cover";
  audioAssetId?: string;
  burnCaptions: boolean;
  updatedAt: number;
  revision: number;
  exportAssetId?: string;
}
export interface Settings {
  outputDir: string;
  proxy: string;
  apiEnabled: boolean;
  apiPort: number;
}
export interface MuseStatus {
  state: "unknown" | "ready" | "login_required" | "busy" | "error";
  message: string;
  url?: string;
}
export interface ExportStatus {
  projectId: string;
  state: "rendering" | "completed" | "failed";
  progress: number;
  error?: string;
  assetId?: string;
}
export interface AppState {
  settings: Settings;
  muse: MuseStatus;
  jobs: Job[];
  assets: Asset[];
  projects: Project[];
  exports: ExportStatus[];
  queuePaused: boolean;
  version: string;
  api: { running: boolean; port: number; error?: string };
}
export interface CreateJob {
  kind: JobKind;
  prompt: string;
  referenceIds?: string[];
  requestId: string;
  conversationUrl?: string;
  projectId?: string;
  shotId?: string;
}
export interface DesktopBridge {
  invoke<T = unknown>(command: string, input?: unknown): Promise<T>;
  onState(callback: (state: AppState) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}
declare global {
  interface Window {
    senmuse: DesktopBridge;
  }
}
