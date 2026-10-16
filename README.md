# Repo Pane for Git

Một plugin cho Claude Code (terminal và app desktop) để làm việc với Git ngay trong Claude: một pane bên cạnh hội thoại và một dòng trạng thái phía trên ô nhập.

## Tính năng

- **Repo trên máy**: trạng thái mọi repo và worktree (branch, ↑ chưa push / ↓ cần pull, file thay đổi), gom theo tài khoản (thu gọn, lật trang), fetch định kỳ, pull từng worktree hoặc tất cả. Repo trên máy chưa theo dõi được báo để thêm hoặc bỏ qua.
- **Từng repo**:
  - **Thay đổi**: nhóm file thu gọn được, lật trang 10 file và lọc theo tên; chọn nhiều file (☐) để stage / unstage / stash / bỏ / thêm .gitignore cùng lúc; menu ⋯ cho từng file; thao tác cho toàn bộ (stash tất cả, bỏ thay đổi chưa stage, xoá file mới, reset toàn bộ); diff dài cuộn 40 dòng một lần; xử lý conflict; **✨ Gợi ý commit message** bằng Claude theo phong cách repo, commit / amend / push ngay sau commit
  - **Branch**: tạo, checkout, merge, rebase, push, đổi tên, xoá, mở worktree; branch trên remote
  - **Lịch sử**: tìm commit, đồ thị commit vẽ bằng SVG (dạng chữ trên terminal); cherry-pick, revert, reset, tạo branch/tag tại commit
  - **Git-flow**: bật như `git flow init` (tương thích git-flow AVH / SourceTree), bắt đầu và hoàn tất feature / bugfix / release / hotfix / support
  - **Stash**, **Tag**, **Pull request** (xem, tạo), **Nâng cao** (pull merge/rebase, force push with lease, reset, clean, worktree, submodule), **Cài đặt** (remote, user.name / user.email)
  - **Publish lên remote**: repo chưa có remote thì tạo repo mới trên GitHub / Bitbucket / GitLab (public hoặc private), gắn `origin` rồi push
- **Repo trên remote**: liệt kê repo theo từng tài khoản đã đăng nhập, tìm kiếm, clone.
- **Khi có gì thay đổi**:
  - Repo trên remote đổi tên hoặc chuyển owner: plugin nhận ra từ thông báo của nhà cung cấp và có nút **Cập nhật URL**.
  - Link remote không còn: **Tìm link mới** trong các tài khoản, hoặc sửa URL tay; nút **Kiểm tra link remote** trong tab Cài đặt.
  - Thư mục repo bị đổi tên, di chuyển hoặc xoá: **Chỉ lại thư mục**, **Tìm thư mục** (theo remote) hoặc **Bỏ theo dõi**.
- Kết quả thao tác gần nhất nằm ở cuối pane, gọn một dòng, mở ra xem chi tiết.
- **⟳ Làm mới** trên thanh trên cùng (phím `r`): đọc lại đúng thứ đang xem (repo, danh sách trên remote, hoặc kiểm tra lại mọi tài khoản).
- **Tài khoản**: Bitbucket, GitHub, GitLab (cả GitHub Enterprise / GitLab tự host), ba kiểu đăng nhập:
  - OAuth qua trình duyệt (cần một OAuth app, xem bên dưới)
  - API token / personal access token: đọc từ clipboard, không gõ vào pane và không hiện ra
  - Chỉ SSH key: tạo key, copy public key, kiểm tra kết nối
  - Chọn giao thức HTTPS hoặc SSH cho từng tài khoản. Remote của repo và `~/.ssh/config` không bị sửa.
- **Tool cho Claude**: `status`, `accounts`, `publish`, `push`, `pull`, `fetch`, `create_pull_request` (tên đầy đủ `mcp__repo-pane__<tool>`). Bạn nhờ Claude "tạo repo rồi push" hay "mở pull request", Claude làm bằng tài khoản đã đăng nhập trong plugin.

Mỗi phiên Claude đang mở đều nạp plugin, nên việc đọc trạng thái và fetch định kỳ được chia sẻ giữa các phiên (một phiên chạy git, các phiên khác dùng lại kết quả), chạy tối đa 4 lệnh git cùng lúc, và phiên chạy nền chỉ đọc lại 5 phút một lần.

Token và secret lưu trong macOS Keychain qua `git credential`. Plugin không ghi chúng ra file nào. Khi plugin chạy git, git chỉ được đọc token, không xoá được nó kể cả khi nhà cung cấp từ chối; tài khoản thiếu hoặc bị từ chối token hiện rõ kèm nút **Đăng nhập lại**. Khi git bị từ chối, plugin hỏi API của nhà cung cấp để phân biệt token hỏng với repo không có quyền, nên một repo không vào được không làm tài khoản báo lỗi.

## Cài đặt

Trong một phiên Claude Code ở terminal:

```
/plugin install repo-pane --marketplace okumurarin96/repo-pane
```

Trả lời `y` để thêm marketplace, rồi chọn scope (mặc định: user). Mở pane bằng `/repo-pane`.

Lần đầu chạy, nếu chưa theo dõi repo nào, plugin tự quét thư mục home để bạn chọn. Cũng có thể điền sẵn danh sách repo trong cài đặt plugin (`repos`, các đường dẫn ngăn cách bằng dấu phẩy).

## OAuth một nút cho cả nhóm

Mỗi nhà cung cấp cần một OAuth app, đăng ký một lần. Callback / redirect URL: `http://127.0.0.1:53682/callback`.

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
claude plugin test .
```

## Giấy phép

[Apache License 2.0](LICENSE).

## Nhãn hiệu

Git là nhãn hiệu của Software Freedom Conservancy; dự án này không liên kết với và không được Git Project chứng nhận. GitHub, Bitbucket, GitLab, Sourcetree và Claude là nhãn hiệu của chủ sở hữu tương ứng; các tên này chỉ dùng để mô tả khả năng tương thích.
