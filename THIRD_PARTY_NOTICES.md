# Third-party components

## FFmpeg and ffmpeg-static

SenMuse invokes FFmpeg as a separate executable to render local media. Source installations use the platform-specific executable downloaded by `ffmpeg-static`. The npm package is licensed under GPL-3.0-or-later. FFmpeg's applicable license depends on its build configuration.

- Package source and license — https://github.com/eugeneware/ffmpeg-static
- FFmpeg source — https://ffmpeg.org/download.html#get-sources
- FFmpeg licensing — https://ffmpeg.org/legal.html

The packaged SenMuse application excludes the FFmpeg executable. On the first export it downloads the platform-specific helper directly from the pinned `eugeneware/ffmpeg-static` release `b6.1.1`, verifies the archive against a SHA-256 checksum recorded in `src/main/ffmpeg.ts`, and installs it in the user's local application data directory. A failed download can be retried by exporting again. No Homebrew or manual terminal setup is needed.

The Apple Silicon binary in that release declares `--enable-nonfree` and says it is not legally redistributable. Do not include this executable in SenMuse release archives. Its upstream source, notices and build information remain available from the binary provider. The SenMuse source license does not replace third-party licenses.

SenMuse has not modified the FFmpeg executable.

## Noto Sans CJK SC

The application includes `NotoSansCJKsc-Regular.otf` for dependable Chinese subtitle rendering on all supported systems. Copyright belongs to the Noto project contributors. It is distributed under the SIL Open Font License 1.1, reproduced at `assets/fonts/OFL.txt`.

- Source — https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese
- License — https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE

The bundled font is unmodified.
