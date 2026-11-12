#!/usr/bin/env node
// Adapter template, deliberately UNCONFIGURED until bound to a verified Muse runtime.
// Do not advertise capabilities or return files that the runtime has not produced.
import { access } from "node:fs/promises";
import { constants } from "node:fs";

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Adapter request is too large");
  }
  const message = JSON.parse(input);
  if (message.protocol !== "senmuse-provider-v1")
    throw new Error("Unsupported adapter protocol");
  if (message.operation === "capabilities") {
    send({ type: "capabilities", ...(await inspectNativeCapabilities()) });
  } else if (message.operation === "generate") {
    const status = await inspectNativeCapabilities();
    if (status.state !== "ready") throw new Error(status.message);
    if (!status.capabilities.includes(message.request?.kind))
      throw new Error("This generation kind is not supported");
    const result = await generateNative(message.request, message.outputDir, {
      submitted: (conversationId) =>
        send({
          type: "submitted",
          ...(conversationId ? { conversationId } : {}),
        }),
      progress: (message) => send({ type: "progress", message }),
    });
    send({ type: "result", ...result });
  } else throw new Error("Unknown adapter operation");
} catch (error) {
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

async function inspectNativeCapabilities() {
  // Replace only after reading the installed CLI --help / SDK contract.
  // Discovery never spends quota. Existence does not prove account availability.
  let installed = false;
  try {
    await access("/opt/hatch/bin/media-generation", constants.X_OK);
    installed = true;
  } catch {}
  return {
    state: "unconfigured",
    capabilities: [],
    message: installed
      ? "检测到 Muse 媒体组件；请先依据本机 --help 或 SDK 契约绑定此适配器。"
      : "未检测到 /opt/hatch/bin/media-generation；请探测当前 Muse 主机的真实组件。",
  };
}

async function generateNative(_request, _outputDir, _events) {
  // Bind to a documented local function or spawn(executable, argv, {shell:false}).
  // Copy returned media into outputDir and return absolute paths and actual MIME.
  // Emit submitted as soon as the native runtime acknowledges the task.
  // Propagate account/permission/region/quota errors. Do not retry by other endpoints.
  // Handle SIGTERM: stop local work; do not claim remote cancellation unless confirmed.
  throw new Error(
    "Muse 原生媒体适配器尚未绑定；模板不会生成测试文件或伪造成功。",
  );
}
