#!/usr/bin/env node
// Node 24 runs the shared TypeScript media engine directly. No npm install is needed.
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error(
    "森映云端入口需要 Node.js 24 或更新版本。已有 npm 时可用 npx --yes --package=node@24 node scripts/senmuse.mjs <命令>。",
  );
  process.exitCode = 1;
} else {
  const { main } = await import("../src/cloud/cli.ts");
  await main(process.argv.slice(2));
}
