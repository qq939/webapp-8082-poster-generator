---
name: github
description: Git and GitHub operations specialist for local repositories and GitHub remotes. Use when Codex needs to inspect or modify git history, branches, remotes, tags, submodules, worktrees, stashes, commits, diffs, merges, rebases, releases, pull requests, issues, GitHub Actions, Codespaces, gists, repository settings, GitHub API calls, or any task that should be performed with git or the GitHub CLI (`gh`).
---

# GitHub

Use this skill to operate Git and GitHub deliberately through `git` and `gh`.

## First Steps

1. Load the local skill environment when GitHub authentication may be needed:

   ```bash
   source /Users/jimjiang/.agents/skills/github/scripts/load_env.sh
   ```

2. Identify context before changing anything:

   ```bash
   git status --short --branch
   git remote -v
   git branch --show-current
   gh auth status --hostname github.com
   ```

3. Protect user work. Never discard, overwrite, amend, rebase, force-push, delete branches/tags, close issues/PRs, change repository settings, rotate secrets, or trigger destructive workflow actions unless the user clearly asked for that operation.

4. Prefer `gh` for GitHub objects and `git` for repository history. Use the GitHub connector only when the user asks for connector-backed GitHub context or when it gives safer structured reads than raw CLI output.

## Command Discovery

For any less-common operation, inspect the installed command before running it:

```bash
git help -a
git help <command>
gh help
gh <area> --help
gh <area> <command> --help
```

Use JSON output when available:

```bash
gh pr view <number> --json title,state,author,headRefName,baseRefName,reviewDecision,statusCheckRollup
gh issue list --json number,title,state,labels,assignees,updatedAt
```

Read [references/command-map.md](references/command-map.md) when the task involves unfamiliar `git`/`gh` areas, repository administration, Actions, releases, API calls, or a multi-step workflow.

## Working Rules

- Keep operations scoped to the current repository unless the user names another repo or `--repo OWNER/REPO` is clearly required.
- Quote branch names, paths, titles, and bodies safely.
- Use non-interactive commands whenever possible: `--yes`, `--confirm`, `--json`, `--body-file`, `--notes-file`, or stdin files.
- Check `git status --short` before and after edits or git operations.
- Preserve unrelated working tree changes. Stage only files that belong to the requested change.
- Explain risky commands before running them when they affect shared remote state.
- Do not print secrets. If `.env` must be inspected, report only whether keys are present.

## Common Workflows

### Inspect

```bash
git status --short --branch
git log --oneline --decorate --graph -20
git diff --stat
git diff -- <path>
gh repo view --json nameWithOwner,defaultBranchRef,visibility,url
gh pr status
```

### Branch and Commit

```bash
git switch -c codex/<short-purpose>
git add <paths>
git diff --cached
git commit -m "<message>"
```

Commit only after the user asks, or when the current task explicitly includes publishing or PR creation.

### Publish and PR

```bash
git push -u origin HEAD
gh pr create --draft --title "<title>" --body-file <body-file>
gh pr view --web
```

Before creating a PR, summarize changed files and verification. Use draft PRs by default unless the user asks for a ready PR.

### Issues

```bash
gh issue list --state open
gh issue view <number> --comments
gh issue create --title "<title>" --body-file <body-file>
gh issue comment <number> --body-file <body-file>
```

### Actions

```bash
gh run list --limit 10
gh run view <run-id> --log-failed
gh workflow list
gh workflow run <workflow> --ref <branch>
```

Do not rerun, cancel, or dispatch workflows unless the user requested it.

## Authentication

The skill-local `.env` may define `GITHUB_TOKEN` or `GH_TOKEN`. `scripts/load_env.sh` exports both names when either exists so `gh` and API calls work consistently.

If auth fails:

1. Run `source /Users/jimjiang/.agents/skills/github/scripts/load_env.sh`.
2. Run `gh auth status --hostname github.com`.
3. If needed, run `gh auth login` only when interactive login is acceptable to the user.

Never include token values in final answers, logs, comments, commits, PR bodies, or issue bodies.
