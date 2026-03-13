---
description: Build, bump version, push git, and deploy to Vercel production
---

# Deploy Workflow

Quy trình deploy production: bump version → build → commit → push → deploy Vercel.

## Steps

// turbo-all

1. **Check git status** — xem có thay đổi chưa commit không:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && git status --short
```

2. **Read current version** from package.json:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && node -e "console.log(require('./package.json').version)"
```

3. **Bump version** — tăng patch version (1.0.0 → 2.0.0 → 3.0.0, etc.). The version number = deploy count, so increment the MAJOR version:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && npm version major --no-git-tag-version
```

4. **Build production** — đảm bảo code compile OK:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && npm run build
```

5. **Git add + commit** — ASK the user for a commit message. Use format: `vX.0.0 — <message>`. Example: `v2.0.0 — Fix face detection bug`. Add ALL changed files:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && git add -A && git commit -m "<version message>"
```

6. **Git tag** — tag the commit with the version:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && git tag -a v<N> -m "Version <N>: <short description>"
```

7. **Git push + tags**:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && git push && git push --tags
```

8. **Deploy to Vercel production**:
```bash
cd /Users/tuuyenlemai/Working/Antigravity/Thubinh_web && vercel --prod --yes
```

9. **Confirm** — report the deployed URL and version to the user.

## Notes
- Version scheme: V1, V2, V3... (major version = deploy count)
- Git tags: v1, v2, v3...
- Live URL: https://thubinh-web.vercel.app
- If vercel login expired, run `vercel login` first
