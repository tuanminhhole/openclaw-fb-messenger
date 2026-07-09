---
name: Update
description: Bump version, cập nhật CHANGELOG, typecheck/build/test, publish GitHub + ClawHub
---

# Workflow: Update & Release (openclaw-fb-messenger)

> Publish plugin lên **GitHub main + ClawHub** (repo **public**; **KHÔNG** publish npm — `package.json` để `private: true`).
> Công cụ một-lệnh: `npm run release [patch|minor|major|x.y.z]` (= `node docs_dev/scripts/update.mjs`).
> Nó tự làm: **typecheck → build → test → bump version → git commit/tag/push → clawhub publish**.
> ⚠️ Vì nó auto-publish, mọi doc (CHANGELOG) phải sửa **XONG TRƯỚC KHI** chạy.

Khi nói **/update**: làm tuần tự B1→B6 dưới đây (đừng bỏ bước nào).

---

## Bước 1 — Chọn mức bump (QUAN TRỌNG)

Xem thay đổi kể từ release cuối: `git log --oneline $(git describe --tags --abbrev=0 2>/dev/null)..HEAD` + `git status`.

| Loại thay đổi | Mức bump | Ví dụ |
|---|---|---|
| **Tính năng mới / đổi hành vi đáng kể** | **MINOR** `x.Y.0` | 0.1.0 → **0.2.0** |
| **Fix lắt nhắt, tweak nhỏ, sửa lỗi đơn lẻ** | **PATCH** `x.y.Z` | 0.1.0 → **0.1.1** |
| Redesign / breaking change lớn | MAJOR `X.0.0` | 0.x → 1.0.0 |

→ Ghi ra version MỚI; lệnh release ở B5 phải khớp mức (`minor`/`patch`).

## Bước 2 — CHANGELOG.md (BẮT BUỘC)

Thêm entry MỚI lên đầu `CHANGELOG.md`, đúng version B1, nội dung THỰC TẾ của release:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Changed / Fixed / Security
- **Tên mục**: mô tả ngắn, súc tích, đúng thay đổi thật.
```

## Bước 3 — README / manifest (nếu đổi)

- Nếu đổi config/env/hành vi → cập nhật `README.md` + `README.vi.md` cho khớp.
- `logo.svg` hiển thị trên ClawHub qua field `icon` trong `openclaw.plugin.json`
  (`https://cdn.jsdelivr.net/gh/tuanminhhole/openclaw-fb-messenger@main/logo.svg`).
  Nếu đổi logo, sửa `logo.svg` rồi purge cache jsDelivr nếu cần.

## Bước 4 — Kiểm tra working tree

`git status -sb` — chỉ chứa thứ muốn phát hành (`update.mjs` dùng `git add -A` gom hết).
`docs_dev/`, `.agent/`, `node_modules/`, `dist/` bị git- và/hoặc clawhub-ignore nên không lộ tooling.

## Bước 5 — Chạy release (một lệnh)

```bash
npm run release minor      # tính năng mới
npm run release patch      # fix lắt nhắt
# npm run release --dry            # xem trước, KHÔNG đổi/publish gì (an toàn)
# npm run release patch --no-clawhub   # chỉ push git, bỏ clawhub
# npm run release patch --no-git       # chỉ bump + verify, không đụng git/clawhub
```
`update.mjs` tự động:
1. `npm run typecheck` → `npm run build` (tsup → `dist/`) → `npm test` (smoke).
2. Bump version `package.json` → version mới.
3. `git add -A` → commit → tag `v<new>` → **push main + tags**. Nếu push 403 do sai account → **tự `gh auth switch -u tuanminhhole` + `gh auth setup-git`** rồi thử lại.
4. `clawhub package publish tuanminhhole/openclaw-fb-messenger --dry-run` rồi publish thật (publish TỪ GitHub main → push B5.3 phải xong trước). Mặc định BẬT; `--no-clawhub` để bỏ.

## Bước 6 — Verify

```bash
git tag --points-at HEAD             # v<new>
git status -sb                       # đã sync origin
# mở https://clawhub.ai/tuanminhhole/openclaw-fb-messenger — version mới + logo hiển thị
```

---

## Checklist
```
[ ] B1: Chọn mức bump (minor=tính năng / patch=lắt nhắt) → ghi version mới
[ ] B2: CHANGELOG.md — entry mới, nội dung thực tế
[ ] B3: (nếu đổi) README + manifest/logo
[ ] B4: git status sạch, đúng thứ cần publish
[ ] B5: npm run release <minor|patch>  (auto typecheck→build→test→bump→git→clawhub)
[ ] B6: verify tag + origin + trang ClawHub (version + logo)
```

## Ghi chú sống còn
- **Tiền đề auth**: `gh` login account chủ repo (`tuanminhhole`); `npx clawhub login` (nếu chưa).
- **Repo public, npm private**: `package.json` giữ `"private": true` → không lỡ tay `npm publish`. Chỉ ship qua ClawHub.
- **`docs_dev/` + `.agent/` bị git-/clawhub-ignore** → chứa tooling (`update.mjs`) & workflow này → **backup riêng** kẻo mất.
- `logo.svg` nằm trong `files` (package) + git-track → ship kèm & hiển thị trên ClawHub; đừng xoá khỏi `files`.
- **Server Docker** (khi deploy lên vps): đổi `.env` phải `docker compose up -d` (recreate) — **KHÔNG `restart`**.
