# Đóng góp cho Repo Pane for Git

Cảm ơn bạn đã muốn đóng góp.

## Giấy phép của phần đóng góp

Theo Điều 5 của [Apache License 2.0](LICENSE), mọi đóng góp bạn gửi vào dự án (pull request, patch) được cấp phép theo chính Apache License 2.0, trừ khi bạn nói rõ khác. Bạn vẫn giữ quyền tác giả đối với phần mình viết.

## Xác nhận nguồn gốc (DCO)

Mỗi commit cần có dòng `Signed-off-by`, xác nhận bạn có quyền gửi phần code đó theo [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```
git commit -s
```

Lệnh này thêm dòng `Signed-off-by: Tên Của Bạn <email>` vào cuối commit message.

Không gửi code bạn không có quyền chia sẻ, ví dụ code chép từ dự án có giấy phép không tương thích hoặc code thuộc về công ty bạn khi chưa được phép.

## Thông báo bản quyền trong file

- **Không xoá hay sửa** các dòng `Copyright` và `SPDX-License-Identifier` đang có ở đầu file.
- **File mới bạn tạo**: thêm ở đầu file

  ```
  // Copyright <năm> <tên của bạn>
  // SPDX-License-Identifier: Apache-2.0
  ```

- **Sửa nhiều ở một file có sẵn**: bạn có thể thêm một dòng `// Copyright <năm> <tên của bạn>` ngay dưới dòng có sẵn. Sửa nhỏ thì không cần; lịch sử Git đã ghi lại tác giả từng thay đổi.

## Code viết với công cụ AI

Nếu dùng công cụ AI để viết code, ghi rõ trong commit bằng dòng `Co-Authored-By` như dự án vẫn làm, và tự kiểm tra rằng phần code đó không chép từ nguồn có giấy phép khác.
