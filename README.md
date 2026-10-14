# git-client

Một git client chạy ngay trong Claude Code (terminal và app desktop): pane **Git** bên cạnh hội thoại và một dòng trạng thái phía trên ô nhập.

## Tính năng

- **Repo trên máy**: trạng thái mọi repo và worktree (branch, ↑ chưa push / ↓ cần pull, file thay đổi), fetch định kỳ, pull từng worktree hoặc tất cả.
- **Từng repo**:
  - **Thay đổi**: stage/unstage, xem diff, bỏ thay đổi, xử lý conflict, commit / amend / push ngay sau commit
  - **Branch**: tạo, checkout, merge, rebase, push, đổi tên, xoá, mở worktree; branch trên remote
  - **Lịch sử**: tìm commit, đồ thị commit vẽ bằng SVG (dạng chữ trên terminal); cherry-pick, revert, reset, tạo branch/tag tại commit
  - **Git-flow**: bật như `git flow init` (tương thích git-flow AVH / SourceTree), bắt đầu và hoàn tất feature / bugfix / release / hotfix / support
  - **Stash**, **Tag**, **Pull request** (xem, tạo), **Nâng cao** (pull merge/rebase, force push with lease, reset, clean, worktree, submodule), **Cài đặt** (remote, user.name / user.email)
- **Repo trên remote**: liệt kê repo của mọi tài khoản đã đăng nhập, tìm kiếm, clone.
- **Tài khoản**: Bitbucket, GitHub, GitLab (cả GitHub Enterprise / GitLab tự host), ba kiểu đăng nhập:
  - OAuth qua trình duyệt (cần một OAuth app, xem bên dưới)
  - API token / personal access token: đọc từ clipboard, không gõ vào pane và không hiện ra
  - Chỉ SSH key: tạo key, copy public key, kiểm tra kết nối
  - Chọn giao thức HTTPS hoặc SSH cho từng tài khoản. Remote của repo và `~/.ssh/config` không bị sửa.

Token và secret lưu trong macOS Keychain qua `git credential`. Mod không ghi chúng ra file nào.

## Cài đặt

Trong một phiên Claude Code ở terminal:

```
/plugin install git-client --marketplace okumurarin96/claude-git-client
```

Trả lời `y` để thêm marketplace, rồi chọn scope (mặc định: user). Mở pane bằng `/git-repos`.

Lần đầu chạy, nếu chưa theo dõi repo nào, mod tự quét thư mục home để bạn chọn. Cũng có thể điền sẵn danh sách repo trong cài đặt plugin (`repos`, các đường dẫn ngăn cách bằng dấu phẩy).

## OAuth một nút cho cả nhóm

Mỗi nhà cung cấp cần một OAuth app, đăng ký một lần (giống Atlassian đã làm sẵn cho SourceTree). Callback / redirect URL: `http://127.0.0.1:53682/callback`.

| Nhà cung cấp | Tạo ở đâu | Điền vào cài đặt plugin |
|---|---|---|
| Bitbucket | Workspace settings → OAuth consumers → Add consumer (private consumer; quyền Account, Workspace membership, Repositories write, Pull requests write) | `bitbucketOAuthKey`, `bitbucketOAuthSecret` |
| GitHub | Settings → Developer settings → OAuth Apps (bật *Enable Device Flow*) | `githubOAuthClientId` (+ `githubHost`) |
| GitLab | Preferences → Applications (bỏ *Confidential*; scopes `api read_repository write_repository`) | `gitlabOAuthClientId` (+ `gitlabHost`) |

Có thể nhập các giá trị này ngay trong tab Tài khoản thay vì sửa cài đặt.

## Yêu cầu

- macOS (dùng Keychain, `pbcopy` / `pbpaste`, `open`)
- `git`; `python3` (cho đăng nhập OAuth qua trình duyệt); `ssh-keygen` (cho phần SSH key)

## Phát triển

```
claude plugin validate .
claude plugin test .
```
