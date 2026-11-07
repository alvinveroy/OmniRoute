#!/usr/bin/env bash
# Guarded OmniRoute build for the shared VPS (ai.servers.com: 8 cores / 30 GB,
# co-tenant containers). A plain `npm run build` there has twice OOM-wedged the
# host and driven load to 178 until sshd banner-timed out.
#
# Every build now runs inside a transient systemd unit with:
#   * a hard memory ceiling  -> the host never OOMs; the build dies instead
#   * throttling at MemoryHigh -> reclaim pressure stays off the co-tenants
#   * low CPU/IO weight + nice -> sshd and the 1 GB of swap stay responsive
#   * a task cap and a runtime cap -> no fork bomb, no zombie build
#   * a watchdog -> aborts the unit when the host loses headroom
#
# Usage (as the deploy user, passwordless sudo):
#   scripts/deploy/vps-guarded-build.sh build   # npm run build (webpack)
#   scripts/deploy/vps-guarded-build.sh cli     # npm run build:cli
#   scripts/deploy/vps-guarded-build.sh pack    # npm pack
#   scripts/deploy/vps-guarded-build.sh raw -- <command...>
#
# Tunables: OMNI_BUILD_MEM_MAX, OMNI_BUILD_MEM_HIGH, OMNI_BUILD_MEM_SWAP_MAX,
# OMNI_BUILD_RUNTIME_MAX, OMNI_BUILD_MIN_AVAIL_MB, OMNI_BUILD_ABORT_AVAIL_MB,
# OMNI_BUILD_MAX_LOAD_PER_CPU, OMNI_BUILD_ABORT_LOAD_PER_CPU.
set -euo pipefail

MEM_MAX=${OMNI_BUILD_MEM_MAX:-20G}
MEM_HIGH=${OMNI_BUILD_MEM_HIGH:-16G}
MEM_SWAP_MAX=${OMNI_BUILD_MEM_SWAP_MAX:-4G}
RUNTIME_MAX=${OMNI_BUILD_RUNTIME_MAX:-3600}
MIN_AVAIL_MB=${OMNI_BUILD_MIN_AVAIL_MB:-6144}
ABORT_AVAIL_MB=${OMNI_BUILD_ABORT_AVAIL_MB:-2048}
MAX_LOAD_PER_CPU=${OMNI_BUILD_MAX_LOAD_PER_CPU:-1.2}
ABORT_LOAD_PER_CPU=${OMNI_BUILD_ABORT_LOAD_PER_CPU:-3.0}

phase=${1:-build}
shift || true
[[ ${1:-} == "--" ]] && shift

case "$phase" in
  build) cmd=${OMNI_BUILD_CMD:-"npm run build"} ;;
  cli)   cmd=${OMNI_BUILD_CMD:-"npm run build:cli"} ;;
  pack)  cmd=${OMNI_BUILD_CMD:-"npm pack"} ;;
  raw)   cmd="$*" ;;
  *)     echo "usage: $0 build|cli|pack|raw -- <command...>" >&2; exit 2 ;;
esac
[[ -n "$cmd" ]] || { echo "no command for phase '$phase'" >&2; exit 2; }

ncpu=$(nproc)
avail_mb() { awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo; }
load1() { cut -d' ' -f1 /proc/loadavg; }
# sshd sessions here are non-login shells without nvm/node on PATH; resolve the
# interpreter explicitly so `npm run build` works inside the unit.
node_bin=$(command -v node 2>/dev/null || true)
[[ -n "$node_bin" ]] || node_bin=$(bash -lc 'command -v node' 2>/dev/null || true)
[[ -n "$node_bin" ]] || node_bin="$HOME/node/bin/node"
node_dir=$(dirname "$node_bin")

# One build at a time: two concurrent builds share the ceiling and defeat both.
exec 9>/tmp/omniroute-build.lock
flock -n 9 || { echo "another guarded build holds /tmp/omniroute-build.lock" >&2; exit 1; }

avail=$(avail_mb); load=$(load1)
awk -v a="$avail" -v need="$MIN_AVAIL_MB" 'BEGIN{exit !(a<need)}' && {
  echo "refusing to start: MemAvailable ${avail}MB < ${MIN_AVAIL_MB}MB" >&2; exit 1;
}
awk -v l="$load" -v n="$ncpu" -v max="$MAX_LOAD_PER_CPU" 'BEGIN{exit !(l>n*max)}' && {
  echo "refusing to start: load1 ${load} > ${ncpu} x ${MAX_LOAD_PER_CPU}" >&2; exit 1;
}

unit="omniroute-${phase}-$(date +%Y%m%d-%H%M%S)"
echo "[guard] unit=${unit} cmd='${cmd}' avail=${avail}MB load1=${load} ncpu=${ncpu}"
echo "[guard] caps: MemoryMax=${MEM_MAX} MemoryHigh=${MEM_HIGH} MemorySwapMax=${MEM_SWAP_MAX}" \
     "CPUWeight=40 IOWeight=40 TasksMax=2048 RuntimeMaxSec=${RUNTIME_MAX}"

# Webpack, not Turbopack: Turbopack's Rust allocator ignores NODE_OPTIONS and
# needs ~22 GB for this repo on this box.
sudo systemd-run --unit="$unit" --wait --pipe \
  --uid="$(id -u)" --gid="$(id -g)" --working-directory="$PWD" \
  -p MemoryMax="$MEM_MAX" -p MemoryHigh="$MEM_HIGH" -p MemorySwapMax="$MEM_SWAP_MAX" \
  -p CPUWeight=40 -p IOWeight=40 -p TasksMax=2048 -p Nice=10 -p OOMScoreAdjust=500 \
  -p RuntimeMaxSec="$RUNTIME_MAX" \
  --setenv=HOME="$HOME" \
  --setenv=OMNIROUTE_USE_TURBOPACK=0 \
  --setenv=NEXT_BUILD_CPUS="${NEXT_BUILD_CPUS:-2}" \
  --setenv=NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" \
  --setenv=PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$node_dir" \
  -- bash -lc "$cmd" &
run_pid=$!

# Watchdog: the cgroup cap protects memory; this protects the host's headroom
# (CPU saturation is what made sshd unreachable, not the OOM kill alone).
abort_file=$(mktemp)
{
  while kill -0 "$run_pid" 2>/dev/null; do
    sleep 10
    a=$(avail_mb); l=$(load1)
    reason=""
    if awk -v a="$a" -v need="$ABORT_AVAIL_MB" 'BEGIN{exit !(a<need)}'; then
      reason="MemAvailable ${a}MB < ${ABORT_AVAIL_MB}MB"
    elif awk -v l="$l" -v n="$ncpu" -v max="$ABORT_LOAD_PER_CPU" 'BEGIN{exit !(l>n*max)}'; then
      reason="load1 ${l} > ${ncpu} x ${ABORT_LOAD_PER_CPU}"
    fi
    if [[ -n "$reason" ]]; then
      printf '%s' "$reason" > "$abort_file"
      echo "[guard] ABORT — ${reason}; stopping ${unit}" >&2
      sudo systemctl stop "$unit" >/dev/null 2>&1 || true
      break
    fi
  done
} &
wd_pid=$!
wait "$run_pid" || rc=$?
kill "$wd_pid" 2>/dev/null || true
abort_reason=$(cat "$abort_file" 2>/dev/null || true)
rm -f "$abort_file"
rc=${rc:-0}

result=$(sudo systemctl show "$unit" -p Result --value 2>/dev/null || true)
status=$(sudo systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)
code=$(sudo systemctl show "$unit" -p ExecMainCode --value 2>/dev/null || true)
sudo systemctl reset-failed "$unit" >/dev/null 2>&1 || true

if [[ -n "$abort_reason" ]]; then
  echo "[guard] build aborted by watchdog: ${abort_reason}" >&2
  exit 137
fi
# An interrupted phase is NOT a successful phase: an externally stopped unit
# reports Result=success and a zero exit status, so the unit's own exit status
# has to be checked too — otherwise a killed build looks green and the next
# phase packs a partial tree.
if [[ "$rc" -ne 0 || "$result" != "success" || -z "$status" || "$status" != "0" ]]; then
  echo "[guard] build failed: rc=${rc} unit_result=${result:-unknown} exec_status=${status:-?} exec_code=${code:-?}" >&2
  [[ "$result" == "oom-kill" ]] && echo "[guard] OOM-killed: raise OMNI_BUILD_MEM_MAX or lower NEXT_BUILD_CPUS/NODE_OPTIONS" >&2
  [[ "$result" == "success" && "$rc" == "0" ]] && echo "[guard] the unit was interrupted (exit status ${status:-?}/${code:-?}) — refusing to report success" >&2
  exit $(( rc == 0 ? 1 : rc ))
fi
echo "[guard] ${phase} OK in ${unit}"