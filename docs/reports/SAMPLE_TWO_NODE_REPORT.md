# SAMPLE - LiteFS 2-node song song report

> Đây là report mẫu để minh họa format kết quả rõ ràng khi kiểm thử 2 node chạy song song.

- Timestamp: 2026-04-06T10:00:00Z
- Node 1 app URL: http://node1.example.internal:20128
- Node 2 app URL: http://node2.example.internal:20128
- Duration: 600s
- Interval: 5s
- Total samples: 120
- Overall status: **PASS**

## Kết quả chi tiết

| Check | Node 1 | Node 2 |
|---|---:|---:|
| /api/storage/health (OK/Total) | 120/120 (100.00%) | 119/120 (99.17%) |
| /v1/models (OK/Total) | 120/120 (100.00%) | 118/120 (98.33%) |

## Diễn giải ngắn

- Cả 2 node đều phục vụ request ổn định trong phần lớn thời gian test.
- Node 2 có một vài nhịp rớt ngắn (1-2 mẫu), cần kiểm tra thêm log LiteFS proxy và Consul lease khi có load cao.
- Khuyến nghị tiếp: chạy soak 2-4 giờ + test kill primary để đo downtime failover thực tế.
