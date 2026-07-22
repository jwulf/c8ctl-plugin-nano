/**
 * Single source of truth for the platform-specific binary packages.
 *
 * Each entry maps a Node platform/arch pair to:
 *   - pkg:   the npm package name that carries the binary for that platform.
 *            Scoped under @nanobpm (a scope we own) so the names can never be
 *            squatted or npm-security-held the way an unscoped name can.
 *   - os:    the npm "os" field value (process.platform)
 *   - cpu:   the npm "cpu" field value (process.arch)
 *   - armVersion: (32-bit ARM only) the host ARM version this binary targets.
 *            npm's `cpu` is just "arm" for BOTH armv6 and armv7, so the two
 *            32-bit ARM packages share os/cpu and are disambiguated at runtime
 *            by the host's reported ARM version (see `platformForHost`).
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
    pkg: '@nanobpm/c8ctl-plugin-nano-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    triple: 'aarch64-apple-darwin',
    asset: `${BIN_BASENAME}-darwin-arm64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    triple: 'x86_64-apple-darwin',
    asset: `${BIN_BASENAME}-darwin-x64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-linux-x64',
    os: 'linux',
    cpu: 'x64',
    triple: 'x86_64-unknown-linux-gnu',
    asset: `${BIN_BASENAME}-linux-x64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    triple: 'aarch64-unknown-linux-gnu',
    asset: `${BIN_BASENAME}-linux-arm64`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-linux-armv7',
    os: 'linux',
    cpu: 'arm',
    armVersion: 7,
    triple: 'armv7-unknown-linux-gnueabihf',
    asset: `${BIN_BASENAME}-linux-armv7`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-linux-armv6',
    os: 'linux',
    cpu: 'arm',
    armVersion: 6,
    triple: 'arm-unknown-linux-gnueabihf',
    asset: `${BIN_BASENAME}-linux-armv6`,
    bin: BIN_BASENAME,
  },
  {
    pkg: '@nanobpm/c8ctl-plugin-nano-win32-x64',
    os: 'win32',
    cpu: 'x64',
    triple: 'x86_64-pc-windows-msvc',
    asset: `${BIN_BASENAME}-win32-x64.exe`,
    bin: `${BIN_BASENAME}.exe`,
  },
];

/**
 * The npm-reported ARM version of the host (6, 7, 8, ...), or 0 when unknown or
 * not ARM. Node stamps this into `process.config` at build time: a 32-bit
 * hardfloat build reports 6 (Pi 1 / Zero) or 7 (Pi 2/3/4 on a 32-bit OS, most
 * modern 32-bit SBCs). Absent on 64-bit and non-ARM builds.
 */
function hostArmVersion() {
  const v = parseInt(process.config?.variables?.arm_version, 10);
  return Number.isFinite(v) ? v : 0;
}

/** The platform package that matches the host running this code, or undefined. */
export function platformForHost(platform = process.platform, arch = process.arch) {
  // 32-bit ARM: process.arch is 'arm' for BOTH armv6 and armv7, so os/cpu alone
  // can't choose between the two packages. Pick on the host's ARM version. An
  // armv6 binary also runs on armv7 (v7 is backward-compatible), so when the
  // version is unknown fall back to armv6 — the universally-runnable 32-bit
  // hardfloat build.
  if (platform === 'linux' && arch === 'arm') {
    const want = hostArmVersion() >= 7 ? 7 : 6;
    return (
      PLATFORMS.find((p) => p.os === 'linux' && p.cpu === 'arm' && p.armVersion === want) ||
      PLATFORMS.find((p) => p.os === 'linux' && p.cpu === 'arm' && p.armVersion === 6)
    );
  }
  return PLATFORMS.find((p) => p.os === platform && p.cpu === arch);
}
