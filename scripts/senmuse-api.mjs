#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("森映 API 需要 Node.js 24 或更新版本。");
  process.exitCode = 1;
} else {
  const { main } = await import("../src/api/cli.ts");
  await main(process.argv.slice(2));
}
