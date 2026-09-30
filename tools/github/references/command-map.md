# Git and GitHub Command Map

Use this reference as a routing map. Confirm exact flags with `git help <command>` or `gh <area> <command> --help` before uncommon or high-impact operations.

## Git Local Repository

- Status and identity: `git status`, `git config`, `git rev-parse`, `git remote -v`
- History: `git log`, `git show`, `git blame`, `git reflog`, `git bisect`
- Diffs: `git diff`, `git diff --cached`, `git range-diff`, `git shortlog`
- Branches: `git branch`, `git switch`, `git checkout`, `git merge-base`
- Staging and commits: `git add`, `git restore --staged`, `git commit`, `git commit --amend`
- Undo and recovery: `git restore`, `git revert`, `git reset`, `git reflog`
- Integration: `git merge`, `git rebase`, `git cherry-pick`, `git revert`
- Remote sync: `git fetch`, `git pull --ff-only`, `git push`, `git remote`, `git ls-remote`
- Tags: `git tag`, `git push --tags`, `git describe`
- Stash: `git stash push`, `git stash list`, `git stash show`, `git stash pop`
- Worktrees: `git worktree list`, `git worktree add`, `git worktree remove`
- Submodules: `git submodule status`, `git submodule update --init --recursive`
- Maintenance: `git gc`, `git fsck`, `git clean`, `git sparse-checkout`, `git lfs`

Treat `git reset --hard`, `git clean`, force pushes, history rewrites, tag deletion, and remote deletion as destructive.

## GitHub CLI Areas

- Authentication: `gh auth status`, `gh auth login`, `gh auth token`, `gh auth refresh`
- Repositories: `gh repo view`, `gh repo list`, `gh repo clone`, `gh repo fork`, `gh repo create`, `gh repo edit`, `gh repo archive`, `gh repo delete`
- Pull requests: `gh pr list`, `gh pr view`, `gh pr checkout`, `gh pr diff`, `gh pr create`, `gh pr edit`, `gh pr comment`, `gh pr review`, `gh pr merge`, `gh pr close`, `gh pr reopen`, `gh pr ready`
- Issues: `gh issue list`, `gh issue view`, `gh issue create`, `gh issue edit`, `gh issue comment`, `gh issue close`, `gh issue reopen`, `gh issue transfer`
- Actions: `gh run list`, `gh run view`, `gh run watch`, `gh run rerun`, `gh run cancel`, `gh workflow list`, `gh workflow view`, `gh workflow run`, `gh workflow enable`, `gh workflow disable`
- Releases: `gh release list`, `gh release view`, `gh release create`, `gh release upload`, `gh release edit`, `gh release delete`, `gh release download`
- Gists: `gh gist list`, `gh gist view`, `gh gist create`, `gh gist edit`, `gh gist delete`
- Codespaces: `gh codespace list`, `gh codespace create`, `gh codespace ssh`, `gh codespace logs`, `gh codespace delete`
- Projects: `gh project list`, `gh project view`, `gh project item-list`, `gh project item-add`
- Labels and metadata: `gh label list`, `gh label create`, `gh label edit`, `gh label delete`
- Secrets and variables: `gh secret list`, `gh secret set`, `gh secret delete`, `gh variable list`, `gh variable set`, `gh variable delete`
- GitHub API: `gh api <endpoint>`, `gh api graphql -f query='<query>'`
- Extensions: `gh extension list`, `gh extension install`, `gh extension upgrade`, `gh extension remove`

Treat repo edits, branch protection changes, secret changes, workflow dispatches, merges, release deletion, repo archive/delete, and project mutations as high-impact.

## Safe Patterns

### JSON Reads

Use JSON for machine-readable state:

```bash
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission
gh pr list --state open --json number,title,author,headRefName,baseRefName,reviewDecision,updatedAt
gh run list --limit 20 --json databaseId,displayTitle,status,conclusion,workflowName,headBranch,updatedAt
```

### File Bodies

For multi-line PR, issue, release, or comment text, write a temporary body file and pass it with `--body-file` or `--notes-file`.

### Cross-Repo Commands

When outside the target repository or working across repos, use:

```bash
gh <area> <command> --repo OWNER/REPO
```

### GraphQL

Use GraphQL when REST/standard `gh` output cannot expose needed fields:

```bash
gh api graphql -f query='
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    nameWithOwner
    defaultBranchRef { name }
  }
}' -F owner=OWNER -F name=REPO
```

## Verification Checklist

- Confirm current branch and remote.
- Confirm authentication and repo permissions.
- For write operations, preview target state where possible.
- For commits, inspect `git diff --cached`.
- For PRs/releases/issues, read back the created or edited object with `gh ... view`.
- Report command outcomes without exposing secrets.
