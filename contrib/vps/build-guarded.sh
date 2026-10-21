#!/bin/bash
# Guarded OmniRoute build for a shared VPS.
#
# The build (webpack + Next.js) is the single most memory-hungry step of the
# release pipeline. On a shared box an unbounded build has historically taken
# the whole machine into swap-thrash or the OOM killer, which makes the box
# unreachable (ssh hangs, the daemon dies with it) even though nothing is
# actually wrong with the box.
#
# This wrapper runs the build inside a transient systemd unit with hard
# resource limits, so:
#
#   * MemoryMax caps the build's cgroup. When the build exceeds it, the
#     kernel OOM-kills *the build only* - the box, sshd and the running
#     OmniRoute daemon keep their memory and stay reachable.
#   * MemorySwapMax bounds how much swap the build may consume, so a runaway
#     build cannot fill the swap device and stall every other process.
#   * CPUWeight / IOWeight keep the build from starving the co-tenants that
#     share the box.
#   * The build itself runs webpack (OMNIROUTE_USE_TURBOPACK=0) with a
#     bounded Next.js worker count and a bounded V8 heap, because the
#     defaults scale with the host's core count and host RAM.
#
# Usage:
#   contrib/vps/build-guarded.sh [--branch <ref>] [--unit <name>]
#
# Environment overrides:
#   BUILD_MEMORY_MAX      cgroup memory cap        (default 20G)
#   BUILD_MEMORY_SWAP_MAX cgroup swap cap           (default 4G)
#   BUILD_MEMORY_HIGH     cgroup soft memory limit  (default 16G)
#   BUILD_CPU_WEIGHT      cgroup CPU weight         (default 60)
#   BUILD_IO_WEIGHT       cgroup IO weight          (default 40)
#   BUILD_HEAP_MB         V8 heap cap in MB         (default 8192)
#   BUILD_CPUS            Next.js build workers     (default 2)
#   BUILD_MIN_FREE_MB     refuse to start below this much free RAM (default 4096)

set -o pipefail

REPO_DIR="${REPO_DIR:-$HOME/OmniRoute}"
BRANCH=""
UNIT_NAME="omniroute-build-$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_FILE:-$HOME/build-guarded.log}"

MEMORY_MAX="${BUILD_MEMORY_MAX:-20G}"
MEMORY_HIGH="${BUILD_MEMORY_HIGH:-16G}"
MEMORY_SWAP_MAX="${BUILD_MEMORY_SWAP_MAX:-4G}"
CPU_WEIGHT="${BUILD_CPU_WEIGHT:-60}"
IO_WEIGHT="${BUILD_IO_WEIGHT:-40}"
HEAP_MB="${BUILD_HEAP_MB:-8192}"
CPUS="${BUILD_CPUS:-2}"
MIN_FREE_MB="${BUILD_MIN_FREE_MB:-4096}"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --unit) UNIT_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export PATH="$HOME/node/bin:/usr/local/bin:/usr/bin:/bin"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "not a git checkout: $REPO_DIR" >&2
  exit 1
fi

# --- preflight: refuse to start a memory-hungry build on a starved box ----
free_mb=$(awk '/^Mem:/ {print $7}' /proc/meminfo)
swap_free_mb=$(awk '/^Swap:/ {print $4}' /proc/meminfo)
echo "[guard] available memory: ${free_mb} MB, free swap: ${swap_free_mb} MB"
if [ "${free_mb}" -lt "${MIN_FREE_MB}" ]; then
  echo "[guard] REFUSING to start: only ${free_mb} MB available (need ${MIN_FREE_MB} MB)." >&2
  echo "[guard] free memory or add swap before building." >&2
  exit 1
fi

cd "$REPO_DIR" || exit 1

if [ -n "$BRANCH" ]; then
  echo "=== checkout ${BRANCH} ==="
  git fetch --all --prune 2>&1 | tail -3
  git checkout "$BRANCH" 2>&1 | tail -3
fi
git log --oneline -1

# --- install dependencies inside the guard as well ------------------------
install_cmd="npm install 2>&1 | tail -20"

# --- the guarded build ----------------------------------------------------
# systemd-run --scope is not used: a scope cannot own the unit's lifetime for
# a long script, and a transient *service* lets `systemctl stop` cancel the
# build cleanly if the operator needs to.
run_in_unit() {
  sudo -n systemd-run \
    --unit="$UNIT_NAME" \
    --collect \
    --property="MemoryMax=$MEMORY_MAX" \
    --property="MemoryHigh=$MEMORY_HIGH" \
    --property="MemorySwapMax=$MEMORY_SWAP_MAX" \
    --property="CPUWeight=$CPU_WEIGHT" \
    --property="IOWeight=$IO_WEIGHT" \
    --property="OOMPolicy=stop" \
    --setenv="PATH=$PATH" \
    --setenv="HOME=$HOME" \
    --setenv="OMNIROUTE_USE_TURBOPACK=0" \
    --setenv="NEXT_BUILD_CPUS=$CPUS" \
    --setenv="NODE_OPTIONS=--max-old-space-size=$HEAP_MB" \
    --working-directory="$REPO_DIR" \
    /bin/bash -lc "$1"
}

echo "=== npm install (guarded) ==="
run_in_unit "$install_cmd"
install_status=$?
if [ $install_status -ne 0 ]; then
  echo "[guard] npm install failed (status $install_status)" >&2
  exit $install_status
fi

echo "=== build (guarded: $MEMORY_MAX cap, $CPUS cpus, ${HEAP_MB}MB heap) ==="
run_in_unit "npm run build 2>&1 | tee -a '$LOG_FILE' | tail -40"
build_status=${PIPESTATUS[0]}
if [ $build_status -ne 0 ]; then
  echo "[guard] build failed (status $build_status); see $LOG_FILE" >&2
  exit $build_status
fi

echo "=== build:cli (guarded) ==="
run_in_unit "npm run build:cli 2>&1 | tee -a '$LOG_FILE' | tail -20"
cli_status=${PIPESTATUS[0]}
if [ $cli_status -ne 0 ]; then
  echo "[guard] build:cli failed (status $cli_status); see $LOG_FILE" >&2
  exit $cli_status
fi

echo "=== pack ==="
npm pack 2>&1 | tail -3
pack=$(ls -t ./*.tgz 2>/dev/null | head -1)
if [ -z "$pack" ]; then
  echo "[guard] npm pack produced no tarball" >&2
  exit 1
fi
echo "[guard] artifact: $PWD/$pack"
echo "=== DONE ==="
