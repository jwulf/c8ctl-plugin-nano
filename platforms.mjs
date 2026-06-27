/**
 * Single source of truth for the platform-specific binary packages.
 *
 * Each entry maps a Node platform/arch pair to:
 *   - pkg:   the npm package name that carries the binary for that platform
 *   - os:    the npm "os" field value (process.platform)
 *   - cpu:   the npm "cpu" field value (process.arch)
 *   - triple: the Rust target triple (informational; used by the Nano BPM CI)
 *   - asset: the GitHub Release asset name uploaded by the Nano BPM CI
 *   - bin:   the binary file name inside the platform package
 *
 * Consumed by the build/publish scripts here and by the plugin's binary
 * resolution at runtime. The Nano BPM CI must upload one asset per row using
 * the exact `asset` name to the rolling `binaries` release on this repo.
 */

export const ROOT_PKG = 'c8ctl-plugin-nano';
export const BIN_BASENAME = 'nanobpm-gateway-rest-server';

export const PLATFORMS = [
  {
    pkg: 'c8ctl-plugin-nano-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    triple: 'aarch64-apple-darwin',
    asset: `${BIN_BASENAME}-darwin-arm64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: 'c8ctl-plugin-nano-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    triple: 'x86_64-apple-darwin',
    asset: `${BIN_BASENAME}-darwin-x64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: 'c8ctl-plugin-nano-linux-x64',
    os: 'linux',
    cpu: 'x64',
    triple: 'x86_64-unknown-linux-gnu',
    asset: `${BIN_BASENAME}-linux-x64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: 'c8ctl-plugin-nano-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    triple: 'aarch64-unknown-linux-gnu',
    asset: `${BIN_BASENAME}-linux-arm64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: 'c8ctl-plugin-nano-win32-x64',
    os: 'win32',
    cpu: 'x64',
    triple: 'x86_64-pc-windows-msvc',
    asset: `${BIN_BASENAME}-win32-x64.exe`,
    bin: `${BIN_BASENAME}.exe`,
  },
];

/** The platform package that matches the host running this code, or undefined. */
export function platformForHost(platform = process.platform, arch = process.arch) {
  return PLATFORMS.find((p) => p.os === platform && p.cpu === arch);
}
