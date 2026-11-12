import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const tag = process.env.RELEASE_TAG ?? "";
const mode = process.env.RELEASE_MODE ?? "";
const commit = process.env.GITHUB_SHA ?? "";
const repo = process.env.GH_REPO ?? "";
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("A valid release_tag is required when publishing");
if (!["draft", "prerelease", "published"].includes(mode)) throw new Error("Unsupported release mode");
if (mode !== "published" && !tag.includes("-")) throw new Error("Manual publishing only supports preview tags such as v0.2.0-preview.1");
if (!/^[0-9a-f]{40}$/.test(commit) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Publishing requires a GitHub Actions commit and repository");
const version = tag.replace(/^v/, "");
if (version.split("-")[0] !== pkg.version.split("-")[0]) throw new Error("Release tag must match package.json");

const archives = ["Windows-x64-portable", "macOS-arm64", "macOS-x64"].map((target) => path.join("release", `SenMuse-${version}-${target}.zip`));
for (const archive of archives) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const checksum = (await fs.readFile(`${archive}.sha256`, "utf8")).trim();
  if (checksum !== `${hash.digest("hex")}  ${path.basename(archive)}`) throw new Error(`Checksum failed: ${archive}`);
}

function gh(args, allowMissing = false) {
  const result = spawnSync("gh", args, { encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404|release not found/i.test(result.stderr)) return null;
    throw new Error(result.stderr || `gh failed with status ${result.status}`);
  }
  return result.stdout.trim();
}

// An existing tag must point at the exact commit that passed the build jobs.
const tagReference = gh(["api", `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`], true);
const tagCommit = tagReference ? gh(["api", `repos/${repo}/commits/${encodeURIComponent(tag)}`, "--jq", ".sha"]) : null;
if (tagCommit && tagCommit !== commit) throw new Error("The release tag points at a different commit; dispatch the workflow on that tag or choose a new preview tag");
const existing = gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease"], true);
let release = existing ? JSON.parse(existing) : null;
if (mode === "published" && (!release || release.isDraft)) throw new Error("Published-release event must refer to an existing published release");
if (mode === "draft" && release && !release.isDraft) throw new Error("A published release cannot be changed back into a draft by this workflow");
if (mode === "prerelease" && release && !release.isDraft && !release.isPrerelease) throw new Error("This workflow cannot replace a stable release with a prerelease");
if (!release) {
  gh(["release", "create", tag, "--repo", repo, "--target", commit, "--draft", "--prerelease", "--title", `SenMuse ${tag}`, "--notes", "森映预览版：Windows x64 免安装便携包、macOS Apple 芯片与 Intel 应用。各包已通过对应平台的测试与启动检查，附 SHA256 校验文件。Linux 云端用法请参阅仓库文档。"]);
  release = { isDraft: true, isPrerelease: true };
}
gh(["release", "upload", tag, "--repo", repo, ...archives.flatMap((archive) => [archive, `${archive}.sha256`]), "--clobber"]);
if (mode === "prerelease" && release.isDraft) gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease"]);
console.log(JSON.stringify({ tag, mode, commit, archives, url: `https://github.com/${repo}/releases/tag/${tag}` }));
