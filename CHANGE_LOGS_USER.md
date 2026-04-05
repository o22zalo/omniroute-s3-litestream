# User-Facing Change Logs

## [2026-04-05] Hỗ trợ chạy nhiều instance đồng thời + khắc phục mất dữ liệu

### Vấn đề đã giải quyết

**Mất cấu hình khi chuyển sang Linux runner:**
Trước đây, nếu kết nối S3 lỗi (sai credentials, network chậm), hệ thống vẫn start
với database rỗng và ghi đè lên data cũ. Nay: hệ thống **từ chối khởi động**
và báo lỗi rõ ràng thay vì âm thầm mất data.

**Không thể chạy nhiều instance đồng thời:**
Chạy 2 instance cùng lúc trước đây sẽ khiến cả 2 ghi lên S3 và corrupt backup.
Nay: hệ thống tự động bầu chọn 1 instance làm **Leader** duy nhất xử lý traffic
và ghi database. Các instance còn lại đứng chờ (Follower) và tự động lên làm
Leader khi instance chính gặp sự cố.

### Cách hoạt động

- **Leader**: chạy đầy đủ — OmniRoute + Litestream backup + Cloudflare Tunnel
- **Follower**: tắt tất cả services — Cloudflare tự động redirect traffic sang Leader
- **Failover**: Leader chết → Follower lên thay trong vòng ~60 giây

### Không cần thay đổi gì từ phía người dùng
Toàn bộ quá trình là tự động. Cấu hình hiện tại không thay đổi.
