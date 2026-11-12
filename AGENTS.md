# Working in SenMuse

SenMuse includes a Chinese desktop application and a standalone cloud CLI for assembling videos from local media. When a user gives this repository to an agent running on a Muse Linux cloud host, follow the cloud workflow in [docs/MUSE_CLOUD.md](docs/MUSE_CLOUD.md).

## Creating a video in a Linux cloud workspace

1. Read the user's requested subject, duration, aspect ratio, supplied media and intended output. Use reasonable defaults for reversible production choices and report those choices with the result.
2. Check the capabilities available in the current session. Identify command execution, local file access, usable image/video/audio generation tools, and a way to return output files. Evaluate the tools actually exposed to this session.
3. Work from the repository root with Node.js 24 or newer. Run `node scripts/senmuse.mjs doctor --json`. When preparation is needed, run `node scripts/senmuse.mjs doctor --prepare --json` and act on its real result. The cloud CLI runs directly from the repository and does not require the desktop application to start.
4. Create a project with `node scripts/senmuse.mjs init <directory> --name "<name>" --aspect "9:16"`. Keep the user's existing files and choose a distinct project directory when needed.
5. Use the current environment's real generation tools to make missing media. Save their outputs to the project directory and inspect the files. Existing user-provided media can be used directly. Record actual local paths in `project.json`.
6. Run `node scripts/senmuse.mjs validate <manifest> --json`, resolve its errors, then run `node scripts/senmuse.mjs render <manifest> --output <directory> --json`.
7. Verify the actual output files, including duration, aspect ratio, visible captions and audio. Return the MP4 and SRT through the environment's supported file delivery mechanism. State any remaining generation or playback problem precisely.

An older system Node.js can be replaced for a command with `npx --yes --package=node@24 node`, when npm and network access are available. This may download Node.js. `doctor` without `--prepare` performs checks. Preparation prefers an available system FFmpeg. When required, it downloads and verifies the pinned Linux x64 or arm64 media tools. `SENMUSE_FFMPEG` selects a user-provided FFmpeg executable and `SENMUSE_CACHE_DIR` selects the component cache directory. Use actual paths available on the host.

## Manifest and generation boundaries

The cloud manifest contains `version: 1`, `name`, `aspect`, `fit`, `burnCaptions`, `shots`, and optional `audio`. Each shot has `file`, `duration`, `caption`, and optional `prompt`. Media paths are relative to the manifest directory. Consult [the complete example](docs/MUSE_CLOUD.md#创建项目和分镜清单) before writing one.

The renderer consumes real files. A shot's `prompt` records its intended content for the agent. Muse generation tools produce media according to their own availability, parameters and account limits. Use documented, callable tools and their returned results. Do not invent a Muse API endpoint, successful generation, download URL, account connection or migrated quota.

If a required generation tool is missing, explain the specific missing capability and the media or user action needed to complete the requested video. Continue any useful work supported by the available assets and authorization. If only still images are available, describe the resulting format accurately and check that it matches the user's intended output. Request consent when an additional paid service or new account connection is needed.

`node scripts/senmuse.mjs demo <directory> --json` generates labelled test media and exercises the real rendering path. Its color plates and short audio are pipeline test assets. Keep test output identified as a test when presenting it.

## Editing the repository

Keep desktop and cloud media behavior consistent by reusing the shared rendering engine. The cloud entry must remain usable on a Node.js host without an Electron window. Validate input paths and media, preserve user files, and report partial failures with actionable errors.

Implement only changes needed for the user's requested outcome. Preserve existing behavior for supported inputs. Run checks appropriate to the change, including actual render verification when media processing changes. Use `npm run typecheck`, `npm test`, and `npm run build` for development after installing development dependencies.

Keep the user-facing interface and workflow guidance in clear Chinese. When describing verification, distinguish local media tests from live Muse account generation. Report what was actually exercised and any remaining unverified step.
