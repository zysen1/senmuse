export type GenerationKind = "video" | "image" | "edit" | "extend";
export interface GenerationInput {
  kind: GenerationKind;
  prompt: string;
  requestId: string;
  referenceIds: string[];
  aspect?: "9:16" | "16:9" | "1:1";
  duration?: number;
  conversationId?: string;
}
export interface ProviderStatus {
  state: "ready" | "login_required" | "unconfigured" | "error";
  message: string;
  capabilities: GenerationKind[];
  aspects?: ("9:16" | "16:9" | "1:1")[];
}
export interface ProviderRequest extends GenerationInput {
  jobId: string;
  references: { path: string; mime: string; name: string }[];
}
export interface ProviderContext {
  signal: AbortSignal;
  outputDir: string;
  onSubmitted(conversationId?: string): void;
  onProgress(message: string): void;
}
export interface ProviderResult {
  conversationId?: string;
  files: { path: string; mime: string; name?: string }[];
}
export interface GenerationProvider {
  status(): Promise<ProviderStatus>;
  run(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderResult>;
  close(): Promise<void>;
}
export interface MuseProviderConfig {
  type: "muse";
  profileDir: string;
  headless?: boolean;
  cdpUrl?: string;
  proxy?: string;
}
export interface CommandProviderConfig {
  type: "command";
  command: string;
  args: string[];
  cwd?: string;
}
export interface ApiConfig {
  version: 1;
  host: string;
  port: number;
  publicUrl?: string;
  tokenFile: string;
  provider: MuseProviderConfig | CommandProviderConfig;
}
export type ApiJobState =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_review";
export interface ApiJob extends GenerationInput {
  id: string;
  status: ApiJobState;
  progress: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  assetIds: string[];
  error?: string;
}
export interface ApiAsset {
  id: string;
  name: string;
  mime: string;
  path: string;
  size: number;
  createdAt: string;
  jobId?: string;
}
