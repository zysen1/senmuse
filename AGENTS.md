# Working in SenMuse

SenMuse includes a Chinese desktop application, a standalone cloud renderer, and an API provider interface. For API installation, networking or Claude/Codex connectivity, start with [docs/AI_DEPLOYMENT.md](docs/AI_DEPLOYMENT.md). Then follow [docs/MUSE_API.md](docs/MUSE_API.md) for a Muse Linux host or [docs/API_GATEWAY.md](docs/API_GATEWAY.md) for the login gateway. When the user asks to create a finished video from media, follow [docs/MUSE_CLOUD.md](docs/MUSE_CLOUD.md).

## Deploying for an actual client

Identify both the API host and the host that actually sends HTTP/MCP requests. The default loopback listener is local to its network namespace; a cloud-hosted client cannot use the user's PC loopback address. Setting `host` or `publicUrl` does not create external connectivity. Follow the deployment runbook to choose a documented native ingress, existing HTTPS proxy or authorized SSH forward. Preserve authentication, existing configuration and user files; use the independent API's HTTP `/mcp` endpoint.

Complete the available installation and configuration work, then verify from the intended client. Report `local_ok`, `remote_ok` and `generation_ok` separately. If the client is inaccessible, mark remote checks unverified and supply executable checks; do not substitute a server-local health request. A working listener, provider `ready`, MCP tool discovery and a real generated video are separate acceptance results.

The outbound worker/relay section is an implementation plan, not a shipped feature. Implement it only within the user's requested scope and available infrastructure, with persistent dispatch state, separate credentials and authenticated media transfer. Never claim an existing relay command, infer ingress from an outbound proxy, or automatically resubmit generation after uncertain dispatch.

## Connecting native Muse components to the API

1. Run `node scripts/probe-muse.mjs --json` inside the actual Muse host. This only inspects known component paths and help; it must not generate media or expose credentials. Treat component presence, account generation availability, quota and network reachability as distinct facts.
2. Read the current host's relevant CLI help and SDK types. `/opt/hatch/bin/media-generation`, the Spaces SDK and networking components are discovery candidates, not guaranteed APIs. Do not invent their arguments or call hidden sockets. Do not change Muse-managed proxy daemons.
3. Run `node scripts/senmuse-api.mjs init --native`; the built-in `scripts/muse-native.mjs` discovers an installed media CLI and enables only operations confirmed by its help. It sends structured prompts and verifies returned `media_paths`. Use `SENMUSE_NATIVE_BIN` for an explicit installed executable. If the runtime differs, use `examples/muse-native-adapter.mjs` to bind its actually documented interface. Keep unavailable modes unconfigured. Do not recursively send generation requests back to the Muse chat agent as a substitute for native integration.
4. Follow `senmuse-provider-v1` JSONL. Capability discovery must not spend generation quota. Advertise only implemented operations, return actual failures, and copy real results into the provided per-job `outputDir`. Stdout is protocol only; never return secret values or arbitrary VM files.
5. Configure the command provider with an executable and separate argument array. Establish client connectivity only through an actually supported and authorized network route. A configured URL or a local listener is not proof of outside reachability. Preserve authentication and describe the connection's actual lifetime.
6. Verify capabilities without generation first. Use user-authorized content for the real generation check. Validate the resulting file and download path. On uncertain dispatch or lost responses, inspect the existing job before any retry; cancellation of local tracking does not prove remote cancellation.
7. Report precisely what works and any missing native tool, permission, account capability or ingress route. Do not claim a live Muse test based on fixtures, an exported runtime snapshot, or file presence alone.

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
