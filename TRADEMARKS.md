# Chính sách tên gọi và thương hiệu / Name and Brand Policy

*Bản tiếng Việt là bản gốc; bản tiếng Anh bên dưới có cùng nội dung. / The Vietnamese text is the original; the English text below says the same.*

## Tiếng Việt

### 1. Phạm vi

Chính sách này áp dụng cho:

- tên **"Repo Pane"** và **"Repo Pane for Git"**;
- tên plugin `repo-pane` khi dùng làm tên sản phẩm (tên plugin, tên marketplace, lệnh `/repo-pane`);
- logo hoặc biểu tượng của dự án, nếu sau này có.

Chính sách này **không** áp dụng cho mã nguồn. Mã nguồn được cấp phép theo [Apache License 2.0](LICENSE) và chính sách này không thêm hạn chế nào vào giấy phép đó. Điều 6 của Apache License 2.0 đã nêu rằng giấy phép không cấp quyền dùng tên thương mại, nhãn hiệu hay tên sản phẩm của người cấp phép; chính sách này mô tả những cách dùng tên mà tác giả cho phép.

"Git" là nhãn hiệu của Software Freedom Conservancy, không thuộc dự án này. Tại thời điểm công bố, "Repo Pane" và "Repo Pane for Git" **chưa được đăng ký nhãn hiệu** ở bất kỳ quốc gia nào.

### 2. Được dùng mà không cần hỏi

- Nói đúng sự thật về nguồn gốc: "dựa trên Repo Pane for Git", "fork từ Repo Pane", "tương thích với Repo Pane", kèm link về https://github.com/okumurarin96/repo-pane.
- Phân phối lại bản **không sửa đổi** dưới đúng tên gốc.
- Bản sửa đổi chỉ dùng **nội bộ** (trong máy bạn, trong công ty bạn) và không phát hành công khai.
- Viết bài, đánh giá, hướng dẫn, so sánh, giảng dạy có nhắc tên dự án.

### 3. Bản fork và sản phẩm phái sinh phát hành công khai

Nếu bạn phát hành công khai một bản đã sửa đổi (miễn phí hay có thu phí):

1. Dùng một **tên khác**, không dễ nhầm với "Repo Pane". Không dùng các tên như "Repo Pane Pro", "Repo Pane X", "RepoPane", "Repo-Pane Plus" hoặc tên chỉ khác "Repo Pane" vài ký tự.
2. Đổi các tên mà người dùng nhìn thấy:
   - `name` và `description` trong `.claude-plugin/plugin.json`;
   - `name`, `plugins[].name` và `description` trong `.claude-plugin/marketplace.json`;
   - tên lệnh và tiêu đề pane trong `hooks/register.tsx` (hằng `PANE`, `TITLE`, lệnh `repo-pane`);
   - tiêu đề và mô tả trong README.
3. Không dùng logo của dự án.
4. Không trình bày sản phẩm của bạn như bản chính thức, bản kế nhiệm, hoặc được tác giả Repo Pane for Git chứng thực, tài trợ hay hỗ trợ.
5. Được và nên ghi: "Dựa trên Repo Pane for Git của okumurarin96 (https://github.com/okumurarin96/repo-pane)".

Khuyến nghị (không bắt buộc): đổi cả các định danh nội bộ như host `*.repo-pane.invalid` trong Keychain, để bản fork và bản gốc cài cùng lúc không dùng chung dữ liệu đăng nhập.

Bạn được bán sản phẩm phái sinh dưới tên của riêng bạn; chính sách này chỉ yêu cầu bạn không dùng tên hay logo của dự án gốc theo cách gây nhầm lẫn.

### 4. Không được

- Dùng "Repo Pane" hoặc tên gần giống làm tên, một phần tên của sản phẩm, dịch vụ, tên miền, tổ chức GitHub, tài khoản mạng xã hội hay marketplace theo cách khiến người dùng nghĩ đó là kênh chính thức.
- Dùng tên hoặc logo của dự án trong quảng cáo theo cách ngụ ý được tác giả chứng thực.

### 5. Xin phép và liên hệ

Trường hợp không có trong chính sách này: mở issue tại https://github.com/okumurarin96/repo-pane/issues. Khi thấy cách dùng chưa phù hợp, tác giả sẽ liên hệ để trao đổi trước.

Bản chính thức chỉ được phát hành từ https://github.com/okumurarin96/repo-pane và marketplace `okumurarin96/repo-pane`.

---

## English

### 1. Scope

This policy covers:

- the names **"Repo Pane"** and **"Repo Pane for Git"**;
- the plugin name `repo-pane` when used as a product name (plugin name, marketplace name, the `/repo-pane` command);
- the project's logo or icon, if one is published later.

This policy does **not** cover the source code. The code is licensed under the [Apache License 2.0](LICENSE), and this policy adds no restriction to that license. Section 6 of the Apache License 2.0 already states that the license does not grant permission to use the Licensor's trade names, trademarks or product names; this policy describes the uses of the name that the author allows.

"Git" is a trademark of Software Freedom Conservancy and does not belong to this project. At the time of publication, "Repo Pane" and "Repo Pane for Git" are **not registered trademarks** in any country.

### 2. Allowed without asking

- Stating the origin truthfully: "based on Repo Pane for Git", "a fork of Repo Pane", "compatible with Repo Pane", with a link to https://github.com/okumurarin96/repo-pane.
- Redistributing **unmodified** copies under the original name.
- Modified versions used **internally** (on your machine, inside your company) and not published.
- Articles, reviews, tutorials, comparisons and teaching that mention the project.

### 3. Publicly distributed forks and derivative products

If you publish a modified version (free or paid):

1. Use a **different name** that is not easily confused with "Repo Pane". Do not use names such as "Repo Pane Pro", "Repo Pane X", "RepoPane", "Repo-Pane Plus", or names that differ from "Repo Pane" by a few characters.
2. Change the names users see:
   - `name` and `description` in `.claude-plugin/plugin.json`;
   - `name`, `plugins[].name` and `description` in `.claude-plugin/marketplace.json`;
   - the command name and pane title in `hooks/register.tsx` (the `PANE` and `TITLE` constants, the `repo-pane` command);
   - the title and description in the README.
3. Do not use the project's logo.
4. Do not present your product as the official version, a successor, or as endorsed, sponsored or supported by the author of Repo Pane for Git.
5. You may, and are encouraged to, state: "Based on Repo Pane for Git by okumurarin96 (https://github.com/okumurarin96/repo-pane)".

Recommended (not required): also change internal identifiers such as the `*.repo-pane.invalid` Keychain hosts, so the fork and the original can be installed together without sharing sign-in data.

You may sell derivative products under your own name; this policy only asks that you do not use the original project's name or logo in a confusing way.

### 4. Not allowed

- Using "Repo Pane" or a confusingly similar name as, or as part of, the name of a product, service, domain name, GitHub organization, social media or marketplace account in a way that makes users think it is an official channel.
- Using the project's name or logo in advertising in a way that implies the author's endorsement.

### 5. Permission and contact

For cases this policy does not cover, open an issue at https://github.com/okumurarin96/repo-pane/issues. When the author sees a use that does not fit this policy, the author will first reach out to discuss it.

Official releases are published only from https://github.com/okumurarin96/repo-pane and the `okumurarin96/repo-pane` marketplace.
