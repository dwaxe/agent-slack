#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

upstream_remote="${AGENT_SLACK_UPSTREAM_REMOTE:-origin}"
fork_remote="${AGENT_SLACK_FORK_REMOTE:-fork}"
fork_owner="${AGENT_SLACK_FORK_GH_USER:-dwaxe}"
publish=false

usage() {
  cat <<'EOF'
Usage: scripts/rebase-fork-main.sh [--push]

Rebase the complete linear fork/main patch stack onto current upstream main,
then run install, lint, formatting, typecheck, build, and tests in an isolated
worktree. Without --push, retain the validated result as a new local branch.
With --push, save the prior fork head on a backup branch and update fork/main
using an exact force-with-lease.

Environment:
  AGENT_SLACK_UPSTREAM_REMOTE  Upstream remote name (default: origin)
  AGENT_SLACK_FORK_REMOTE      Personal fork remote name (default: fork)
  AGENT_SLACK_FORK_GH_USER     gh account for HTTPS pushes (default: dwaxe)
EOF
}

case "${1:-}" in
  "") ;;
  --push) publish=true ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for remote in "$upstream_remote" "$fork_remote"; do
  if [[ ! "$remote" =~ ^[A-Za-z0-9._-]+$ ]] || ! git remote get-url "$remote" >/dev/null 2>&1; then
    printf 'error: required git remote is unavailable: %s\n' "$remote" >&2
    exit 1
  fi
done

require_github_remote() {
  local remote="$1" expected="$2" url
  url="$(git remote get-url "$remote")"
  case "$url" in
    "https://github.com/$expected"|"https://github.com/$expected.git"|"git@github.com:$expected"|"git@github.com:$expected.git") ;;
    *)
      printf 'error: remote %s must target github.com/%s\n' "$remote" "$expected" >&2
      exit 1
      ;;
  esac
}

require_github_remote "$upstream_remote" "stablyai/agent-slack"
require_github_remote "$fork_remote" "dwaxe/agent-slack"

if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' "error: the source worktree must be clean" >&2
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
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    git push "$@"
    return
  fi
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

printf '%s\n' "Fetching upstream main..."
git fetch "$upstream_remote" main
printf '%s\n' "Fetching fork main..."
git fetch "$fork_remote" main

upstream_head="$(git rev-parse "$upstream_remote/main^{commit}")"
fork_head="$(git rev-parse "$fork_remote/main^{commit}")"

if git merge-base --is-ancestor "$upstream_head" "$fork_head"; then
  printf 'fork/main is already based on upstream main (%s).\n' "$upstream_head"
  exit 0
fi

fork_base="$(git merge-base "$upstream_head" "$fork_head")"
if [[ -z "$fork_base" ]]; then
  printf '%s\n' "error: upstream and fork main have no common ancestor" >&2
  exit 1
fi
if [[ "$(git rev-list --merges --count "$fork_base..$fork_head")" != "0" ]]; then
  printf '%s\n' "error: fork patch stack contains merge commits; refusing automatic rebase" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%d%H%M%S)"
integration_branch="dwaxe/rebase-fork-main-$timestamp"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-slack-rebase.XXXXXX")"
rebase_worktree="$temporary_root/worktree"

cleanup() {
  git worktree remove --force "$rebase_worktree" >/dev/null 2>&1 || true
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

git worktree add --detach "$rebase_worktree" "$fork_head"
git -C "$rebase_worktree" rebase --onto "$upstream_head" "$fork_base"

printf '%s\n' "Installing locked dependencies..."
(cd "$rebase_worktree" && run_bun install --frozen-lockfile)
printf '%s\n' "Running fork validation..."
(cd "$rebase_worktree" && run_bun run lint)
(cd "$rebase_worktree" && run_bun run format:check)
(cd "$rebase_worktree" && run_bun run typecheck)
(cd "$rebase_worktree" && run_bun run build)
(cd "$rebase_worktree" && run_bun run test)

rebased_head="$(git -C "$rebase_worktree" rev-parse HEAD)"

if [[ "$publish" != "true" ]]; then
  git branch "$integration_branch" "$rebased_head"
  printf 'Validated rebased branch: %s (%s)\n' "$integration_branch" "$rebased_head"
  exit 0
fi

git fetch "$fork_remote" main
current_fork_head="$(git rev-parse "$fork_remote/main^{commit}")"
if [[ "$current_fork_head" != "$fork_head" ]]; then
  printf 'error: fork/main moved during validation (%s -> %s)\n' "$fork_head" "$current_fork_head" >&2
  exit 1
fi

backup_ref="refs/heads/dwaxe/pre-upstream-rebase-$timestamp"
if git ls-remote --exit-code --heads "$fork_remote" "$backup_ref" >/dev/null 2>&1; then
  printf 'error: backup branch already exists: %s\n' "$backup_ref" >&2
  exit 1
fi

push_to_fork "$fork_remote" "$fork_head:$backup_ref"
push_to_fork \
  --force-with-lease="refs/heads/main:$fork_head" \
  "$fork_remote" \
  "$rebased_head:refs/heads/main"

git fetch "$fork_remote" main
published_head="$(git rev-parse "$fork_remote/main^{commit}")"
if [[ "$published_head" != "$rebased_head" ]]; then
  printf 'error: published fork/main does not match the validated head: %s\n' "$published_head" >&2
  exit 1
fi

printf 'Rebased fork/main from %s onto %s; published %s.\n' \
  "$fork_head" "$upstream_head" "$rebased_head"
printf 'Recovery branch: %s\n' "${backup_ref#refs/heads/}"
