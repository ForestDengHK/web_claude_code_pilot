# CLAUDE.md

## Project Overview

CodePilot -- Claude Code's web GUI, built with Next.js (standalone mode). Deployed as a self-hosted web app.

## Release Checklist

1. Update `"version"` in `package.json` (run `npm install` to sync `package-lock.json`)
2. Commit and push to `main`
3. Create and push a tag: `git tag v{version} && git push origin v{version}`
4. CI (`.github/workflows/build.yml`) automatically:
   - Builds the Next.js standalone app on Ubuntu
   - Creates a GitHub Release with a changelog
5. Optionally add New Features / Bug Fixes notes to the Release page
6. Check CI status: `gh run list` / retry: `gh run rerun <id> --failed`

**Do not manually create a GitHub Release** -- CI handles it automatically.

## Release Discipline

**No automatic releases**: Do not run `git push` + `git tag` + `git push origin tag` after finishing code changes. Wait for explicit user confirmation ("release" / "publish" or similar). Commits are fine, but pushing and tagging require user approval.

## Development Rules

**Test thoroughly before committing:**
- Test all changed functionality in the dev environment before every commit
- For UI changes, start the app with `npm run dev` and verify visually
- For build changes, run `npm run build` to verify the standalone output
- Consider cross-browser differences for frontend changes

**Research before adding features:**
- Investigate technical approaches, API compatibility, and community best practices
- Confirm third-party library compatibility with existing dependencies
- Confirm Claude Code SDK actually supports the features and calling patterns you plan to use
- Do a POC for uncertain technical points; do not experiment directly in main code

## Release Notes Template

**Title**: `CodePilot v{version}`

```markdown
## New Features / Bug Fixes

- **Title** -- Brief description of the change and why it was made

## Deployment

Self-hosted web app. Pull the latest tag and run:

    npm ci && npm run build && npm run start

## Requirements

- Node.js 20+
- Anthropic API Key or `ANTHROPIC_API_KEY` environment variable

## Changelog (since v{previous version})

| Commit | Description |
|--------|-------------|
| `{hash}` | {commit message} |
```

**Notes**:
- Major releases: use `## New Features` + `## Bug Fixes` sections
- Minor/patch releases: `## Bug Fix` is sufficient
- Include Deployment and Requirements every time for new users
- Changelog table lists all commits since the previous version

## Build Notes

- Next.js is configured with `output: 'standalone'` in `next.config.ts`
- `npm run build` produces `.next/standalone/` which includes a minimal Node.js server
- `npm run start` launches the production server (or use `node .next/standalone/server.js`)
- `better-sqlite3` is listed in `serverExternalPackages` so it is not bundled by webpack
- Clean before rebuilding: `rm -rf .next/` to avoid stale output
