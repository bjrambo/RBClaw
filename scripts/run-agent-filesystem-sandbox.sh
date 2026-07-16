#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 5 ]]; then
  echo "usage: $0 <ro|rw> <work-dir> <protected-root> [--writable <path>]... -- <command> [args ...]" >&2
  exit 64
fi

access_mode="$1"
work_dir="$2"
protected_root="$3"
shift 3

if [[ "$access_mode" != "ro" && "$access_mode" != "rw" ]]; then
  echo "invalid work-dir access mode: $access_mode" >&2
  exit 64
fi
if [[ ! -d "$work_dir" ]]; then
  echo "work directory does not exist: $work_dir" >&2
  exit 66
fi
if [[ ! -d "$protected_root" ]]; then
  echo "protected root does not exist: $protected_root" >&2
  exit 66
fi

work_dir="$(realpath "$work_dir")"
protected_root="$(realpath "$protected_root")"
writable_paths=()
while [[ "$#" -gt 0 && "$1" == "--writable" ]]; do
  if [[ "$#" -lt 2 ]]; then
    echo "writable sandbox path is missing" >&2
    exit 64
  fi
  if [[ ! -d "$2" ]]; then
    echo "writable sandbox path does not exist: ${2:-missing}" >&2
    exit 66
  fi
  writable_path="$(realpath "$2")"
  case "$writable_path/" in
    "$work_dir/"*)
      echo "writable sandbox path overlaps read-only work directory: $writable_path" >&2
      exit 65
      ;;
  esac
  case "$work_dir/" in
    "$writable_path/"*)
      echo "writable sandbox path contains work directory: $writable_path" >&2
      exit 65
      ;;
  esac
  writable_paths+=("$writable_path")
  shift 2
done

if [[ "$1" != "--" ]]; then
  echo "missing command separator" >&2
  exit 64
fi
shift
if [[ "$#" -eq 0 ]]; then
  echo "missing sandbox command" >&2
  exit 64
fi

mount --make-rprivate /
mount --bind "$protected_root" "$protected_root"
mount -o remount,ro,bind "$protected_root"

for writable_path in "${writable_paths[@]}"; do
  mount --bind "$writable_path" "$writable_path"
  mount -o remount,rw,bind "$writable_path"
done

mount --bind "$work_dir" "$work_dir"
mount -o "remount,${access_mode},bind" "$work_dir"

mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
if [[ -d /dev/shm ]]; then
  mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm
fi

if [[ ! -x /usr/bin/setpriv ]]; then
  echo "setpriv is required to drop sandbox mount capabilities" >&2
  exit 69
fi

exec /usr/bin/setpriv \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  -- "$@"
