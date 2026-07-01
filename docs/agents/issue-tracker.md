# Issue Tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `moritzbrantner/maps`. Use the `gh` CLI or the GitHub connector for all issue operations.

## Conventions

- Create an issue: `gh issue create --repo moritzbrantner/maps --title "..." --body "..."`
- Read an issue: `gh issue view <number> --repo moritzbrantner/maps --comments`
- List issues: `gh issue list --repo moritzbrantner/maps --state open --json number,title,body,labels,comments`
- Comment on an issue: `gh issue comment <number> --repo moritzbrantner/maps --body "..."`
- Apply or remove labels: `gh issue edit <number> --repo moritzbrantner/maps --add-label "..."` or `--remove-label "..."`
- Close an issue: `gh issue close <number> --repo moritzbrantner/maps --comment "..."`

## Publishing Work

When a skill says "publish to the issue tracker", create a GitHub issue in `moritzbrantner/maps`.

When a skill says "fetch the relevant ticket", run `gh issue view <number> --repo moritzbrantner/maps --comments`.
