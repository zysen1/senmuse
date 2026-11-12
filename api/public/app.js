const $ = (id) => document.getElementById(id);
const KIND = {
  video: "生成视频",
  image: "生成图片",
  edit: "修改视频",
  extend: "续拍视频",
};
const STATES = {
  queued: "等待生成",
  running: "正在生成",
  completed: "已完成",
  failed: "生成前失败",
  cancelled: "已取消",
  needs_review: "需要核查",
};
const PROVIDER = {
  ready: "组件已就绪",
  login_required: "Muse 需要登录",
  unconfigured: "组件尚未配置",
  error: "组件连接失败",
};
const state = {
  token: "",
  session: 0,
  connected: false,
  status: null,
  jobs: [],
  assets: [],
  references: new Set(),
  pending: null,
  submitting: false,
  uploading: false,
  refreshPromise: null,
  timer: null,
  controllers: new Set(),
  blobs: new Set(),
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, id, className = "secondary") {
  const node = element("button", `button small ${className}`, text);
  node.type = "button";
  node.dataset.action = action;
  if (id) node.dataset.id = id;
  return node;
}
function notice(message, kind = "") {
  $("global-notice").textContent = message;
  $("global-notice").className = `notice ${kind}`;
  $("global-notice").hidden = !message;
}
function fail(error) {
  if (error.name === "AbortError") return;
  if (error.status === 401) {
    disconnect("访问令牌已失效或不正确，请重新连接。");
    return;
  }
  notice(error.message || "操作失败，请检查服务后重试。", "error");
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function api(
  route,
  {
    method = "GET",
    body,
    raw = false,
    headers = {},
    timeout = 20_000,
    blob = false,
  } = {},
) {
  const session = state.session;
  const controller = new AbortController();
  state.controllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new Error("请求超时，请检查服务连接。")),
    timeout,
  );
  try {
    const response = await fetch(route, {
      method,
      credentials: "omit",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(body !== undefined && !raw
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: raw ? body : JSON.stringify(body) }
        : {}),
    });
    if (session !== state.session)
      throw new DOMException("连接已退出", "AbortError");
    if (!response.ok) {
      let message = `请求失败（HTTP ${response.status}）`;
      try {
        const data = await response.json();
        if (typeof data.error === "string") message = data.error;
      } catch {}
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const value = blob ? await response.blob() : await response.json();
    if (session !== state.session)
      throw new DOMException("连接已退出", "AbortError");
    return value;
  } finally {
    clearTimeout(timer);
    state.controllers.delete(controller);
  }
}

function disconnect(message = "") {
  state.session++;
  state.token = "";
  state.connected = false;
  clearTimeout(state.timer);
  state.timer = null;
  for (const controller of state.controllers) controller.abort();
  for (const url of state.blobs) URL.revokeObjectURL(url);
  state.blobs.clear();
  state.status = null;
  state.jobs = [];
  state.assets = [];
  state.references.clear();
  state.pending = null;
  state.submitting = false;
  state.uploading = false;
  state.refreshPromise = null;
  $("login-view").hidden = false;
  $("workspace").hidden = true;
  $("token").value = "";
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
  $("generation-form").reset();
  $("jobs").replaceChildren();
  $("assets").replaceChildren();
  notice("");
}
function schedule() {
  clearTimeout(state.timer);
  if (state.connected)
    state.timer = setTimeout(
      () => refresh().catch(pollError),
      document.hidden ? 15_000 : 5_000,
    );
}
function pollError(error) {
  if (error.name === "AbortError") return;
  if (error.status === 401) {
    disconnect("访问令牌已失效，请重新连接。");
    return;
  }
  $("connection-error").textContent =
    `状态更新失败，下面保留的是上次记录：${error.message}。不会自动重发生成请求。`;
  $("connection-error").hidden = false;
}
async function refresh() {
  if (state.refreshPromise) return state.refreshPromise;
  const session = state.session;
  const task = (async () => {
    const [status, jobs, assets] = await Promise.all([
      api("/v1/status", { timeout: 180_000 }),
      api("/v1/jobs"),
      api("/v1/assets"),
    ]);
    if (session !== state.session) return;
    if (
      !status.muse ||
      !Array.isArray(status.muse.capabilities) ||
      !Array.isArray(jobs) ||
      !Array.isArray(assets)
    )
      throw new Error("服务返回的数据格式无法识别");
    state.status = status;
    state.jobs = jobs;
    state.assets = assets;
    if (state.pending) {
      const known = jobs.find(
        (job) => job.requestId === state.pending.requestId,
      );
      if (known) accepted(known);
    }
    $("connection-error").hidden = true;
    $("last-updated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    render();
  })();
  state.refreshPromise = task;
  try {
    await task;
  } finally {
    if (state.refreshPromise === task) state.refreshPromise = null;
    if (session === state.session) schedule();
  }
}

function allowedKinds() {
  return state.status?.muse.state === "ready"
    ? state.status.muse.capabilities.filter((kind) => KIND[kind])
    : [];
}
function aspects() {
  return state.status?.muse.state === "ready" &&
    Array.isArray(state.status.muse.aspects)
    ? state.status.muse.aspects.filter((value) =>
        ["9:16", "16:9", "1:1"].includes(value),
      )
    : [];
}
function syncControls() {
  const supported = allowedKinds();
  for (const option of $("kind").options)
    option.disabled = !supported.includes(option.value);
  if (!supported.includes($("kind").value) && !state.pending)
    $("kind").value = supported[0] || "";
  const previous = $("aspect").value;
  $("aspect").replaceChildren(new Option("由 Muse 决定", ""));
  for (const value of aspects())
    $("aspect").add(
      new Option(
        value === "9:16"
          ? "9:16 竖屏"
          : value === "16:9"
            ? "16:9 横屏"
            : "1:1 方形",
        value,
      ),
    );
  if (aspects().includes(previous)) $("aspect").value = previous;
  $("aspect").disabled = !aspects().length;
  $("aspect-help").textContent = aspects().length
    ? "不指定时使用 Muse 默认画幅，实际输出以生成结果为准。"
    : "当前组件未声明可选画幅，提交时使用默认设置。";
  $("kind-help").textContent = !supported.length
    ? "组件就绪并声明能力后才能提交。"
    : {
        video: "可以添加参考图片。视频时长由当前 Muse 组件决定。",
        image: "描述新画面，也可以添加图片作为参考。",
        edit: "请先上传并选择要修改的视频，再描述修改内容。",
        extend: "请添加已有素材，或填写原任务的会话 ID。",
      }[$("kind").value] || "";
  $("conversation-field").hidden = $("kind").value !== "extend";
  $("draft-fields").disabled =
    Boolean(state.pending) || state.uploading || !state.connected;
  $("generate").disabled =
    state.submitting || state.uploading || !supported.length;
  $("generate").textContent = state.submitting
    ? "正在提交…"
    : state.pending
      ? "使用原请求重试"
      : "开始生成 ↗";
  $("abandon-request").hidden = !state.pending || state.submitting;
  $("submission-warning").hidden = !state.pending;
  $("submission-warning").textContent = state.pending
    ? `正在确认请求 ${state.pending.requestId}。网络失败不代表没有提交；重试会复用相同 ID 和内容。可先在下方队列检查，勿刷新页面后重复创建。`
    : "";
  $("reference-count").textContent = `已选 ${state.references.size} / 4`;
}
function render() {
  if (!state.status) return;
  const provider = state.status.muse;
  $("provider-state").textContent = PROVIDER[provider.state] || "状态未知";
  $("status-dot").className =
    `status-dot ${provider.state === "ready" ? "ready" : provider.state === "error" ? "error" : ""}`;
  $("provider-message").textContent = provider.message || "";
  $("capabilities").replaceChildren(
    ...(allowedKinds().length
      ? allowedKinds().map((kind) => element("span", "capability", KIND[kind]))
      : [element("span", "subtle", "暂未声明可用功能")]),
  );
  $("active-count").textContent = String(
    state.jobs.filter((job) => ["queued", "running"].includes(job.status))
      .length,
  );
  $("queue-state").textContent = state.status.queuePaused
    ? "队列已暂停"
    : "队列运行中";
  $("toggle-queue").textContent = state.status.queuePaused
    ? "继续队列"
    : "暂停队列";
  const review = state.jobs.some((job) => job.status === "needs_review");
  $("queue-explanation").textContent = review
    ? "存在待核查任务。请先在 Muse 检查并确认，再手动继续队列。"
    : "暂停只影响后续任务，正在生成的任务继续运行。";
  syncControls();
  renderReferences();
  renderJobs();
  renderAssets();
}
function suitable(asset) {
  return ["image", "video"].includes($("kind").value)
    ? asset.mime.startsWith("image/")
    : ["edit", "extend"].includes($("kind").value)
      ? /^(image|video)\//.test(asset.mime)
      : false;
}
function renderReferences() {
  $("selected-references").replaceChildren();
  for (const id of state.references) {
    const asset = state.assets.find((asset) => asset.id === id);
    const chip = element("div", "reference-chip");
    chip.append(element("span", "", asset?.name || id));
    const remove = button("×", "remove-reference", id, "quiet");
    remove.setAttribute("aria-label", `移除 ${asset?.name || "参考素材"}`);
    remove.disabled = Boolean(state.pending) || state.uploading;
    chip.append(remove);
    $("selected-references").append(chip);
  }
  const available = state.assets.filter(suitable);
  $("reference-library").replaceChildren(
    ...available.map((asset) => {
      const label = element("label", "reference-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.references.has(asset.id);
      input.dataset.reference = asset.id;
      input.disabled =
        Boolean(state.pending) ||
        state.uploading ||
        (!input.checked && state.references.size >= 4);
      label.append(
        input,
        element("span", "", `${asset.name} · ${formatSize(asset.size)}`),
      );
      return label;
    }),
  );
  if (!available.length)
    $("reference-library").append(
      element("p", "field-help", "没有适合当前类型的素材，可以先上传。"),
    );
  $("reference-count").textContent = `已选 ${state.references.size} / 4`;
}
function empty(title, description) {
  const node = element("div", "empty-state");
  node.append(element("strong", "", title), element("span", "", description));
  return node;
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}
function formatSize(value) {
  return Number.isFinite(value)
    ? value >= 1024 * 1024
      ? `${(value / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(value / 1024))} KB`
    : "";
}
function renderJobs() {
  $("job-count").textContent = String(state.jobs.length);
  $("jobs").replaceChildren();
  if (!state.jobs.length) {
    $("jobs").append(
      empty(
        "第一条创作，从这里开始",
        "写下你的描述。提交后，进度与结果会出现在这里。",
      ),
    );
    return;
  }
  for (const job of state.jobs) {
    const card = element(
      "article",
      `job ${job.status === "needs_review" ? "needs-review" : ""}`,
    );
    const top = element("div", "job-top");
    const status = element("div", "job-status");
    status.append(
      element("span", "", KIND[job.kind] || "生成任务"),
      element("span", `badge ${job.status}`, STATES[job.status] || job.status),
    );
    top.append(status, element("time", "job-time", formatTime(job.createdAt)));
    card.append(
      top,
      element("p", "job-prompt", job.prompt),
      element("p", "job-progress", job.progress || ""),
    );
    if (job.error) card.append(element("p", "job-error", job.error));
    if (job.status === "needs_review")
      card.append(
        element(
          "p",
          "field-help",
          "任务可能已经在 Muse 生成。请先核查；确认后仅结束本地跟踪，不会重新生成。",
        ),
      );
    const actions = element("div", "job-actions");
    if (["queued", "running"].includes(job.status))
      actions.append(
        button(
          job.status === "running" ? "停止等待" : "取消任务",
          "cancel",
          job.id,
          "quiet",
        ),
      );
    if (job.status === "needs_review")
      actions.append(button("我已在 Muse 核查", "resolve", job.id));
    for (const id of job.assetIds || []) {
      const asset = state.assets.find((asset) => asset.id === id);
      actions.append(
        button(
          asset
            ? `下载 ${asset.mime.startsWith("video/") ? "视频" : "图片"}`
            : "下载结果",
          "download",
          id,
        ),
      );
    }
    if (["completed", "failed", "cancelled"].includes(job.status))
      actions.append(button("复用描述", "reuse", job.id, "quiet"));
    if (actions.childNodes.length) card.append(actions);
    const details = element("details", "job-details");
    details.append(
      element("summary", "", "查看完整描述与任务标识"),
      element("p", "", job.prompt),
      element(
        "p",
        "",
        `任务 ID：${job.id}\n请求 ID：${job.requestId}${job.conversationId ? `\n会话 ID：${job.conversationId}` : ""}`,
      ),
    );
    card.append(details);
    $("jobs").append(card);
  }
}
function renderAssets() {
  $("asset-count").textContent = String(state.assets.length);
  $("assets").replaceChildren();
  if (!state.assets.length) {
    $("assets").append(
      empty("这里将收好你的素材", "上传参考文件，或等待第一条创作完成。"),
    );
    return;
  }
  for (const asset of state.assets) {
    const card = element("article", "asset");
    const isVideo = asset.mime.startsWith("video/");
    card.append(
      element("div", "asset-icon", isVideo ? "▶" : "▧"),
      element("h3", "", asset.name),
      element(
        "p",
        "asset-meta",
        `${isVideo ? "视频" : "图片"} · ${formatSize(asset.size)} · ${asset.jobId ? "生成结果" : "上传素材"}`,
      ),
    );
    const actions = element("div", "asset-actions");
    actions.append(button("下载", "download", asset.id));
    const ref = button(
      state.references.has(asset.id) ? "已作参考" : "用作参考",
      "reference",
      asset.id,
      "quiet",
    );
    ref.disabled =
      !suitable(asset) ||
      Boolean(state.pending) ||
      state.references.has(asset.id) ||
      state.references.size >= 4;
    actions.append(ref);
    card.append(actions);
    $("assets").append(card);
  }
}
function accepted(job) {
  if (!state.pending || job.requestId !== state.pending.requestId) return;
  state.pending = null;
  $("prompt").value = "";
  $("conversation").value = "";
  notice(
    `已找到任务 ${job.id}，当前状态：${STATES[job.status] || job.status}。请在队列中查看结果。`,
  );
  syncControls();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  if (!token) return;
  $("login-button").disabled = true;
  $("login-button").textContent = "正在连接…";
  $("login-error").hidden = true;
  state.session++;
  state.token = token;
  try {
    await refresh();
    state.connected = true;
    $("token").value = "";
    $("login-view").hidden = true;
    $("workspace").hidden = false;
    render();
    schedule();
  } catch (error) {
    disconnect(
      error.status === 401
        ? "访问令牌不正确，请核对当前服务的令牌。"
        : `连接失败：${error.message}`,
    );
  } finally {
    $("login-button").disabled = false;
    $("login-button").textContent = "连接服务 ↗";
  }
});
$("logout").addEventListener("click", () => {
  if (
    state.pending &&
    !confirm(
      "这次请求可能已经提交。退出会清除本页的重试记录；请先核对队列，确定退出吗？",
    )
  )
    return;
  disconnect();
});
$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try {
    await refresh();
  } catch (error) {
    pollError(error);
  } finally {
    $("refresh").disabled = false;
  }
});
$("kind").addEventListener("change", () => {
  if (state.pending) return;
  state.references = new Set(
    [...state.references].filter((id) => {
      const asset = state.assets.find((value) => value.id === id);
      return asset && suitable(asset);
    }),
  );
  syncControls();
  renderReferences();
  renderAssets();
});
$("reference-library").addEventListener("change", (event) => {
  const id = event.target.dataset.reference;
  if (!id || state.pending) return;
  if (event.target.checked && state.references.size < 4)
    state.references.add(id);
  else state.references.delete(id);
  renderReferences();
  renderAssets();
});

$("upload").addEventListener("change", async () => {
  const files = [...$("upload").files];
  $("upload").value = "";
  if (!files.length || state.pending) return;
  state.uploading = true;
  syncControls();
  const session = state.session;
  let uploaded = 0;
  try {
    for (const file of files) {
      if (!file.size || file.size > 200 * 1024 * 1024)
        throw new Error(`${file.name} 需要是非空且不超过 200 MiB 的文件`);
      notice(`正在上传 ${file.name}…`);
      const asset = await api("/v1/assets", {
        method: "POST",
        raw: true,
        body: file,
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
        },
        timeout: 120_000,
      });
      state.assets = [
        asset,
        ...state.assets.filter((value) => value.id !== asset.id),
      ];
      uploaded++;
      if (suitable(asset) && state.references.size < 4)
        state.references.add(asset.id);
    }
    notice(
      `已上传 ${uploaded} 个素材。符合当前类型的文件已选为参考，最多 4 个。`,
    );
  } catch (error) {
    if (session === state.session) {
      if (uploaded)
        notice(`已上传 ${uploaded} 个素材；${error.message}`, "error");
      else fail(error);
    }
  } finally {
    if (session === state.session) {
      state.uploading = false;
      render();
    }
  }
});

$("generation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.submitting || state.uploading || !allowedKinds().length) return;
  const session = state.session;
  let attemptedRequest;
  try {
    if (!state.pending) {
      const kind = $("kind").value,
        prompt = $("prompt").value.trim();
      if (!allowedKinds().includes(kind) || !prompt)
        throw new Error("请选择已支持的创作类型并填写描述。");
      const refs = [...state.references];
      if (
        kind === "edit" &&
        !refs.some((id) =>
          state.assets
            .find((asset) => asset.id === id)
            ?.mime.startsWith("video/"),
        )
      )
        throw new Error("修改视频需要先选择一个视频参考素材。");
      const conversationId =
        kind === "extend" ? $("conversation").value.trim() : "";
      if (kind === "extend" && !refs.length && !conversationId)
        throw new Error("续拍需要已有素材或原会话 ID。");
      if (conversationId && !/^[a-zA-Z0-9_-]{1,150}$/.test(conversationId))
        throw new Error("会话 ID 格式不正确。");
      state.pending = {
        requestId: uuid(),
        kind,
        prompt,
        referenceIds: refs,
        ...(aspects().includes($("aspect").value)
          ? { aspect: $("aspect").value }
          : {}),
        ...(conversationId ? { conversationId } : {}),
      };
    }
    state.submitting = true;
    syncControls();
    const request = state.pending;
    attemptedRequest = request;
    const job = await api("/v1/jobs", {
      method: "POST",
      body: request,
      timeout: 60_000,
    });
    if (!job?.id || job.requestId !== request.requestId)
      throw new Error("服务未返回可确认的任务标识，请保留原请求并核查队列。");
    state.jobs = [job, ...state.jobs.filter((value) => value.id !== job.id)];
    accepted(job);
    render();
    await refresh().catch(pollError);
  } catch (error) {
    if (session !== state.session) return;
    const known =
      attemptedRequest &&
      state.jobs.find((job) => job.requestId === attemptedRequest.requestId);
    if (known) {
      accepted(known);
      notice(
        `请求响应中断，但队列已确认任务 ${known.id}。请查看该任务，不需要重复创建。`,
      );
      return;
    }
    if ([400, 409, 413, 415, 422, 429, 507].includes(error.status))
      state.pending = null;
    fail(error);
  } finally {
    if (session === state.session) {
      state.submitting = false;
      syncControls();
    }
  }
});
$("abandon-request").addEventListener("click", () => {
  if (
    !confirm(
      "该请求可能已经提交到 Muse。请先查看任务队列或 Muse 结果。停止重试不会取消已提交的任务，之后再次生成将使用新的请求 ID。确定停止重试吗？",
    )
  )
    return;
  state.pending = null;
  syncControls();
  renderReferences();
  notice("已停止本页重试。已有任务仍可在队列中查询。", "warning");
});
$("toggle-queue").addEventListener("click", async () => {
  if (!state.status) return;
  $("toggle-queue").disabled = true;
  try {
    await api("/v1/queue", {
      method: "POST",
      body: { paused: !state.status.queuePaused },
    });
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    $("toggle-queue").disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const control = event.target.closest("button[data-action]");
  if (!control || control.disabled) return;
  const { action, id } = control.dataset;
  if (action === "remove-reference") {
    state.references.delete(id);
    renderReferences();
    renderAssets();
    return;
  }
  if (action === "reference") {
    if (state.references.size < 4 && !state.pending) {
      state.references.add(id);
      renderReferences();
      renderAssets();
      notice("已加入参考素材。");
    }
    return;
  }
  const job = state.jobs.find((value) => value.id === id);
  if (action === "reuse") {
    if (state.pending) {
      notice("请先确认当前待核查请求，再编辑新创作。", "warning");
      return;
    }
    if (!job || !allowedKinds().includes(job.kind)) {
      notice("当前组件未声明支持这个任务类型。", "error");
      return;
    }
    $("kind").value = job.kind;
    syncControls();
    $("prompt").value = job.prompt;
    $("aspect").value = aspects().includes(job.aspect) ? job.aspect : "";
    $("conversation").value =
      job.kind === "extend" ? job.conversationId || "" : "";
    state.references = new Set(
      (job.referenceIds || [])
        .filter((id) => state.assets.some((asset) => asset.id === id))
        .slice(0, 4),
    );
    renderReferences();
    renderAssets();
    $("create").scrollIntoView({ block: "start" });
    notice("描述已放回创作台。修改后点击“开始生成”才会创建新任务。");
    return;
  }
  if (
    action === "cancel" &&
    job?.submittedAt &&
    !confirm(
      "停止等待不代表 Muse 会取消已经提交的生成。此任务将保留为“需要核查”，请之后到 Muse 检查结果。确定停止等待吗？",
    )
  )
    return;
  if (
    action === "resolve" &&
    !confirm(
      "确认你已在 Muse 检查了这次生成？此操作只结束本地跟踪，不会重新生成，也不会自动继续队列。",
    )
  )
    return;
  control.disabled = true;
  try {
    if (action === "cancel") {
      await api(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      await refresh();
    }
    if (action === "resolve") {
      await api(`/v1/jobs/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { action: "acknowledge" },
      });
      notice("已确认此任务。检查完其他待核查项后，可手动继续队列。");
      await refresh();
    }
    if (action === "download") {
      const file = await api(`/v1/assets/${encodeURIComponent(id)}/file`, {
        blob: true,
        timeout: 120_000,
      });
      const url = URL.createObjectURL(file);
      state.blobs.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        state.assets.find((asset) => asset.id === id)?.name || `senmuse-${id}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        state.blobs.delete(url);
      }, 30_000);
    }
  } catch (error) {
    fail(error);
  } finally {
    control.disabled = false;
  }
});
document.addEventListener("visibilitychange", () => {
  if (state.connected) schedule();
});
window.addEventListener("beforeunload", (event) => {
  if (state.pending || state.uploading) {
    event.preventDefault();
    event.returnValue = "";
  }
});
