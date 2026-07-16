#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "deploy preflight failed: not inside a git worktree" >&2
  exit 2
}

status="$(git -C "$repo_root" status --porcelain --untracked-files=all)"
if [ -n "$status" ]; then
  echo "deploy blocked: git worktree is not clean" >&2
  echo "$status" >&2
  echo "commit or stash the listed changes before deploying" >&2
  exit 1
fi

echo "deploy worktree clean: ${repo_root}"
