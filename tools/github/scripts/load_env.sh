#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${BASH_SOURCE+x}" ]]; then
  script_path="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  script_path="${(%):-%x}"
else
  script_path="$0"
fi

skill_dir="$(cd "$(dirname "${script_path}")/.." && pwd)"
env_file="${skill_dir}/.env"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

if [[ -n "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  export GH_TOKEN="${GITHUB_TOKEN}"
elif [[ -n "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  export GITHUB_TOKEN="${GH_TOKEN}"
fi

if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  echo "No GITHUB_TOKEN or GH_TOKEN found in ${env_file}" >&2
  return 1 2>/dev/null || exit 1
fi
