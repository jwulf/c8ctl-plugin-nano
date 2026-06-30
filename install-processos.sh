#!/usr/bin/env bash
#
# ProcessOS (closed alpha) one-line installer.
#
# Ensures the Camunda 8 CLI (c8ctl) and the c8ctl-plugin-nano plugin are
# installed, then configures the ProcessOS download URL you were given so you
# can run `c8ctl processos start`.
#
# Usage (pass the download URL you were given as an argument):
#
#   curl -fsSL https://gist.githubusercontent.com/jwulf/9015a7c660b274c568d80e85c3914161/raw/install-processos.sh | bash -s -- "<PROCESSOS_DOWNLOAD_URL>"
#   wget  -qO- https://gist.githubusercontent.com/jwulf/9015a7c660b274c568d80e85c3914161/raw/install-processos.sh | bash -s -- "<PROCESSOS_DOWNLOAD_URL>"
#
# …or via the PROCESSOS_DOWNLOAD_URL environment variable:
#
#   curl -fsSL https://gist.githubusercontent.com/jwulf/9015a7c660b274c568d80e85c3914161/raw/install-processos.sh | PROCESSOS_DOWNLOAD_URL="<url>" bash
#
set -euo pipefail

CLI_PKG="@camunda8/cli"
PLUGIN_PKG="c8ctl-plugin-nano"

# --- pretty output ---------------------------------------------------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GRN="$(printf '\033[32m')"; YEL="$(printf '\033[33m')"; RST="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi
say()  { printf '%s\n' "${BOLD}▸ $*${RST}"; }
ok()   { printf '%s\n' "${GRN}✓ $*${RST}"; }
warn() { printf '%s\n' "${YEL}! $*${RST}" >&2; }
die()  { printf '%s\n' "${RED}✗ $*${RST}" >&2; exit 1; }

# --- resolve the download URL (arg wins, then env) -------------------------
DOWNLOAD_URL="${1:-${PROCESSOS_DOWNLOAD_URL:-}}"
if [ -z "${DOWNLOAD_URL}" ]; then
  die "No ProcessOS download URL provided.

Pass the URL you were given by the Nano BPM team, e.g.:
  curl -fsSL <raw-gist-url> | bash -s -- \"https://…/processos/latest/\"
or set PROCESSOS_DOWNLOAD_URL in your environment first."
fi

say "Installing ProcessOS (closed alpha)…"
printf '%s\n' "${DIM}  download url: ${DOWNLOAD_URL}${RST}"

# --- prerequisites: Node.js + npm ------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is required but not found.

Install Node.js 18+ first (https://nodejs.org or 'nvm install --lts'), then
re-run this installer."
fi
if ! command -v npm >/dev/null 2>&1; then
  die "npm is required but not found (it ships with Node.js). Install Node.js 18+ and retry."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ] 2>/dev/null; then
  warn "Node.js ${NODE_MAJOR}.x detected; 18+ is recommended. Continuing anyway."
fi
ok "Node.js $(node -v) / npm $(npm -v)"

# npm global installs may need sudo depending on the prefix. Pick a runner.
npm_global_install() {
  # $1 = package spec
  if npm install -g "$1" >/dev/null 2>&1; then
    return 0
  fi
  warn "Global npm install of '$1' failed without elevated permissions."
  if command -v sudo >/dev/null 2>&1; then
    warn "Retrying with sudo (you may be prompted for your password)…"
    sudo npm install -g "$1"
  else
    die "Could not install '$1' globally. Re-run with a writable npm prefix, e.g.:
  npm config set prefix \"\$HOME/.npm-global\" && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"
then run this installer again."
  fi
}

# --- ensure c8ctl ----------------------------------------------------------
if command -v c8ctl >/dev/null 2>&1; then
  ok "c8ctl already installed ($(c8ctl --version 2>/dev/null | head -n1))"
else
  say "Installing the Camunda 8 CLI (${CLI_PKG})…"
  npm_global_install "${CLI_PKG}"
  command -v c8ctl >/dev/null 2>&1 || die "c8ctl still not on PATH after install. Open a new shell and re-run."
  ok "c8ctl installed ($(c8ctl --version 2>/dev/null | head -n1))"
fi

# --- ensure the nano plugin ------------------------------------------------
if c8ctl list plugins 2>/dev/null | grep -q "^${PLUGIN_PKG}[[:space:]]"; then
  ok "${PLUGIN_PKG} already loaded"
else
  say "Loading the ${PLUGIN_PKG} plugin from npm…"
  c8ctl load plugin "${PLUGIN_PKG}" || die "Failed to load the ${PLUGIN_PKG} plugin. Check your network and retry."
  ok "${PLUGIN_PKG} loaded"
fi

# --- configure the ProcessOS download URL ----------------------------------
say "Configuring the ProcessOS download URL…"
c8ctl processos set download-url "${DOWNLOAD_URL}" || die "Failed to persist the download URL."
ok "ProcessOS download URL configured"

# --- done ------------------------------------------------------------------
cat <<EOF

${GRN}${BOLD}ProcessOS is ready.${RST}

Next steps:
  ${BOLD}c8ctl processos start${RST}      # downloads the matching binary on first run, then starts it
  ${BOLD}c8ctl processos status${RST}     # show ProcessOS status and the cockpit URL
  ${BOLD}c8ctl processos config${RST}     # review configuration and on-disk paths
  ${BOLD}c8ctl processos stop${RST}       # stop ProcessOS

The plugin will let you know (at most once a day) when a newer build is published.
EOF
