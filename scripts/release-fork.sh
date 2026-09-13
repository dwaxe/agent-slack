#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fork_remote="${AGENT_SLACK_FORK_REMOTE:-fork}"
fork_owner="${AGENT_SLACK_FORK_GH_USER:-dwaxe}"
version="${1:-}"
publish="${2:-}"

usage() {
  cat <<'EOF'
Usage: scripts/release-fork.sh <X.Y.Z-dwaxe.N> [--push]

Validate a fork release from the exact remote fork/main head. Without --push,
perform checks only. With --push, create and publish an annotated version tag;
the release workflow builds checksummed binaries using that tag version and
never publishes personal fork tags to npm.
EOF
}

if [[ "$version" == "-h" || "$version" == "--help" ]]; then
  usage
  exit 0
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dwaxe\.[0-9]+$ ]]; then
  usage >&2
  exit 2
fi
if [[ -n "$publish" && "$publish" != "--push" ]] || [[ $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

if [[ ! "$fork_remote" =~ ^[A-Za-z0-9._-]+$ ]] || ! git remote get-url "$fork_remote" >/dev/null 2>&1; then
  printf 'error: required fork remote is unavailable: %s\n' "$fork_remote" >&2
  exit 1
fi
fork_url="$(git remote get-url "$fork_remote")"
case "$fork_url" in
  "https://github.com/dwaxe/agent-slack"|"https://github.com/dwaxe/agent-slack.git"|"git@github.com:dwaxe/agent-slack"|"git@github.com:dwaxe/agent-slack.git") ;;
  *)
    printf 'error: remote %s must target github.com/dwaxe/agent-slack\n' "$fork_remote" >&2
    exit 1
    ;;
esac
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' "error: the worktree must be clean" >&2
  exit 1
fi
if ! node -e 'process.exit(require("semver").valid(process.argv[1]) === process.argv[1] ? 0 : 1)' "$version"; then
  printf 'error: invalid fork release version: %s\n' "$version" >&2
  exit 1
fi

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes bun@1.3.9 "$@"
  else
    printf '%s\n' "error: bun or npx is required" >&2
    return 1
  fi
}

push_to_fork() {
  local fork_url token
  fork_url="$(git remote get-url "$fork_remote")"
  if [[ "$fork_url" == https://github.com/* ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token --user "$fork_owner")"
    AGENT_SLACK_FORK_PUSH_TOKEN="$token" git \
      -c credential.helper= \
      -c 'credential.helper=!f() { printf "username=x-access-token\npassword=%s\n" "$AGENT_SLACK_FORK_PUSH_TOKEN"; }; f' \
      push "$@"
    return
  fi
  git push "$@"
}

git fetch "$fork_remote" main --tags
fork_head="$(git rev-parse "$fork_remote/main^{commit}")"
current_head="$(git rev-parse HEAD)"
if [[ "$current_head" != "$fork_head" ]]; then
  printf 'error: HEAD must equal the current fork/main head (%s)\n' "$fork_head" >&2
  exit 1
fi

tag="v$version"
if git rev-parse "$tag" >/dev/null 2>&1 || \
  git ls-remote --exit-code --tags "$fork_remote" "refs/tags/$tag" >/dev/null 2>&1; then
  printf 'error: release tag already exists: %s\n' "$tag" >&2
  exit 1
fi

latest_tag="$(git tag --list 'v*-dwaxe.*' --sort=-v:refname | head -n 1)"
if [[ -n "$latest_tag" ]] && ! node -e '
  const semver = require("semver");
  process.exit(semver.gt(process.argv[1], process.argv[2]) ? 0 : 1);
' "$version" "${latest_tag#v}"; then
  printf 'error: %s must be newer than %s\n' "$version" "${latest_tag#v}" >&2
  exit 1
fi

run_bun install --frozen-lockfile
run_bun run lint
run_bun run format:check
run_bun run typecheck
run_bun run build
run_bun run test

if [[ "$publish" != "--push" ]]; then
  printf 'Fork release validation passed for %s at %s; rerun with --push to publish.\n' \
    "$version" "$fork_head"
  exit 0
fi

git tag --annotate "$tag" "$fork_head" --message "$tag"
push_to_fork "$fork_remote" "refs/tags/$tag:refs/tags/$tag"
printf 'Published %s at %s. The release workflow will build and checksum its binaries.\n' \
  "$tag" "$fork_head"
