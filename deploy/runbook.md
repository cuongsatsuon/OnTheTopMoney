# Runbook vận hành OnTheTopMoney (một VPS, Docker Compose)

Tài liệu này đủ để dựng app trên một VPS mới, triển khai, quay lại bản cũ, sao lưu và khôi phục mà không cần đọc mã.
Mọi lệnh `docker compose …` chạy trong thư mục `deploy/` của repo trên VPS (ví dụ `~/OnTheTopMoney/deploy`).

## Kiến trúc trong một hình

```
Internet ──80/443──> nginx (máy chủ, bạn tự quản, TLS certbot)
                       ├──> /var/www/ottm/current      web tĩnh (deploy.sh xuất bản, symlink theo tag)
                       ├──> /var/lib/ottm/media        /media (chỉ đọc; api/worker ghi bằng uid 1000)
                       └──> 127.0.0.1:3000 ──> api (docker compose) ──> postgres
                                                  └──> (Meta, OpenAI)          worker ──> postgres
backup (chạy theo cron) ──> pg_dump + media ──restic, mã hoá──> kho S3 khác nhà cung cấp
```

Đây là chế độ mặc định `WEB_MODE=vps` (web + api cùng VPS, cùng tên miền). Chế độ thứ hai — web tĩnh trên Hostinger,
VPS chỉ chạy BE (`WEB_MODE=external`) — xem mục 8; các mục 1–7 vẫn áp dụng, trừ chỗ mục 8 ghi khác.

nginx và certbot **không** nằm trong stack: bạn cài và quản lý chúng trên máy chủ (mục 1.6). Repo chỉ đưa mẫu
cấu hình `deploy/nginx.conf.example`; `deploy.sh` không cài, không sửa, không reload nginx.

| Thành phần | Vai trò | Cổng |
|---|---|---|
| nginx (máy chủ) | HTTPS, phục vụ web từ `WEB_ROOT/current`, `/media` từ `MEDIA_DIR_HOST`, chuyển `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` tới api, header bảo mật | 80, 443 (ra internet) |
| `migrate` | chạy migration DB một lần rồi thoát, trước api/worker | không |
| `api` | REST, SSE, webhook, OAuth | `127.0.0.1:API_HOST_PORT` (chỉ máy chủ) |
| `worker` | job nền, cron | không |
| `postgres` | Postgres 18, dữ liệu ở volume `pgdata` | không |
| `backup`, `restore` | chỉ chạy khi gọi (`docker compose run`) | không |

Dữ liệu: volume Docker `pgdata` (DB), `restic_cache`; thư mục máy chủ `MEDIA_DIR_HOST` (ảnh công khai, mặc định
`/var/lib/ottm/media`) và `WEB_ROOT` (các bản build web, mặc định `/var/www/ottm`). Chứng chỉ TLS ở `/etc/letsencrypt`
(certbot).

---

## 1. Cài lần đầu

### 1.1 Chuẩn bị

- VPS Ubuntu 24.04 (hoặc Debian 12+), tối thiểu 2 vCPU, 4 GB RAM, 40 GB SSD. RAM 2 GB thì thêm 2 GB swap (build web cần bộ nhớ).
- Một tên miền, ví dụ `app.example.com`.
- Một bucket riêng tư ở **nhà cung cấp khác VPS** cho backup (ví dụ Backblaze B2) và một application key chỉ có quyền trên bucket đó.
- Một trình quản lý mật khẩu để cất các bí mật ở mục 1.4.

### 1.2 DNS

Tạo bản ghi `A` (và `AAAA` nếu VPS có IPv6) cho `app.example.com` trỏ về IP của VPS. Kiểm:

```bash
dig +short app.example.com      # phải ra IP của VPS
```

certbot chỉ lấy được chứng chỉ khi DNS đã trỏ đúng và cổng 80 mở (mục 1.6).

### 1.3 Máy chủ: người dùng, firewall, Docker

```bash
# người dùng triển khai (không chạy bằng root)
sudo adduser --disabled-password deploy
sudo usermod -aG sudo deploy

# firewall: chỉ SSH và web
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Lưu ý: Docker tự mở firewall cho cổng mà container publish, bỏ qua ufw. Stack này chỉ publish cổng api trên
`127.0.0.1` (không ra được internet, chỉ nginx trên máy chủ gọi tới); Postgres (5432) không publish. Đừng thêm
`ports:` cho service khác, và đừng đổi `127.0.0.1:` của api thành cổng trần.

Cài Docker Engine và plugin compose theo hướng dẫn chính thức (apt repository):
<https://docs.docker.com/engine/install/ubuntu/>. Sau đó:

```bash
sudo usermod -aG docker deploy      # đăng xuất/đăng nhập lại để có hiệu lực
docker compose version              # cần v2
```

### 1.4 Lấy mã và tạo `deploy/.env`

```bash
sudo -iu deploy
git clone <url-repo> ~/OnTheTopMoney        # repo riêng: dùng deploy key chỉ đọc
cd ~/OnTheTopMoney/deploy
cp env.production.example .env
chmod 600 .env
nano .env
```

Điền theo chú thích trong file. Tối thiểu:

| Biến | Giá trị |
|---|---|
| `PUBLIC_BASE_URL` | `https://app.example.com` (không dấu `/` cuối) — cùng tên miền với `server_name` trong nginx |
| `WEB_MODE` | `vps` (mặc định). `external` = web trên Hostinger (mục 8, kèm `WEB_BASE_URL`, `ALLOWED_ORIGINS`) |
| `WEB_ROOT` | mặc định `/var/www/ottm` (mục 1.5) |
| `MEDIA_DIR_HOST` | mặc định `/var/lib/ottm/media` (mục 1.5) |
| `API_HOST_PORT` | mặc định `3000`; đổi nếu cổng này đã có dịch vụ khác trên máy (nhớ đổi cả `upstream` trong nginx) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `RESTIC_REPOSITORY` | ví dụ `s3:s3.us-west-004.backblazeb2.com/ten-bucket/ottm` |
| `RESTIC_PASSWORD` | `openssl rand -base64 32` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | keyID và applicationKey của B2 |
| `META_APP_ID`, `META_APP_ENV` | để trống `META_APP_ID` tới khi kết nối Meta; khi đặt thì `META_APP_ENV=live` (app không khởi động với Meta Test App) và **bắt buộc** `META_APP_SECRET` |
| `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_APP_ENV` | đặt cả cặp hoặc để trống cả hai; khi đặt thì `THREADS_APP_ENV=live` |
| `APP_ENCRYPTION_KEYS` | **bắt buộc** — `echo "k1:$(openssl rand -base64 32)"` (dạng `<keyId>:<base64 32 byte>`, nhiều khoá phẩy ngăn cách) |
| `APP_ENCRYPTION_ACTIVE_KEY` | **bắt buộc** — keyId đang dùng để mã hoá, phải có trong `APP_ENCRYPTION_KEYS` (vd `k1`) |
| `SESSION_SECRET` | `openssl rand -base64 32` |

Thiếu `APP_ENCRYPTION_KEYS`/`APP_ENCRYPTION_ACTIVE_KEY`, khoá không phải base64 của đúng 32 byte, hoặc
keyId active không có trong danh sách → api, worker, migrate **không khởi động** (exit ≠ 0, log nêu tên biến).
Xem bằng `docker compose logs api`.

**Xoay khoá chủ:** thêm khoá mới vào cuối `APP_ENCRYPTION_KEYS` (giữ khoá cũ), đổi
`APP_ENCRYPTION_ACTIVE_KEY` sang keyId mới, rồi `./deploy/deploy.sh`. Bản ghi cũ vẫn giải mã bằng khoá cũ;
chỉ bỏ khoá cũ khỏi danh sách khi chắc không còn bản ghi nào dùng nó (nếu bỏ sớm: nhập lại khoá OpenAI ở
Cài đặt).

**Cất riêng, ngoài VPS** (trình quản lý mật khẩu), vì backup không chứa chúng:

- `APP_ENCRYPTION_KEYS` và `APP_ENCRYPTION_ACTIVE_KEY` — mất thì khoá OpenAI và token Meta trong DB không giải mã được.
- `RESTIC_PASSWORD`, `RESTIC_REPOSITORY`, khoá B2 — mất `RESTIC_PASSWORD` là không mở được bản backup nào.
- `POSTGRES_PASSWORD`, `SESSION_SECRET`, các app secret của Meta/Threads.

Cách đơn giản: lưu cả nội dung `deploy/.env` thành một mục trong trình quản lý mật khẩu, cập nhật mỗi khi sửa.

### 1.5 Thư mục trên máy chủ

`deploy.sh` không dùng `sudo`; tạo sẵn hai thư mục (đổi đường dẫn nếu `deploy/.env` dùng giá trị khác):

```bash
# Web: deploy.sh (người dùng deploy) ghi vào; nginx (www-data) đọc.
sudo install -d -o deploy -g deploy -m 755 /var/www/ottm
# Media: api/worker trong container chạy bằng uid 1000 (user `node`) và ghi vào; nginx chỉ đọc.
sudo install -d -m 755 /var/lib/ottm
sudo install -d -o 1000 -g 1000 -m 755 /var/lib/ottm/media
```

- Thư mục media phải thuộc **uid 1000** (dù trên máy chủ uid 1000 là người dùng nào — trên Ubuntu thường là người dùng
  tạo đầu tiên) với quyền `755`. `deploy.sh` kiểm (chủ sở hữu, uid 1000 ghi được, nginx đọc được, mọi thư mục cha có
  `o+x`) và dừng kèm lệnh sửa nếu sai.
- `WEB_ROOT` và `MEDIA_DIR_HOST` phải là hai thư mục riêng (không cái nào nằm trong cái kia), đường dẫn tuyệt đối ít
  nhất hai cấp, không phải thư mục hệ thống (`/var/www`, `/var/lib`, `/etc/…` bị từ chối). Docker không tự tạo thư mục này (`create_host_path: false`) để không
  sinh ra thư mục của root mà api không ghi được.
- Các thư mục cha (`/var/www`, `/var/lib/ottm`) phải cho người khác đi qua (`755`), để nginx đọc được.
- Sau deploy, `WEB_ROOT` có dạng `/var/www/ottm/<tag>/…` và symlink `/var/www/ottm/current → <tag>`. Không sửa tay.
- `MEDIA_DIR_HOST` được sao lưu (mục 1.9) và khôi phục (mục 4.2).

### 1.6 nginx và chứng chỉ TLS (certbot)

Bạn tự cài và quản lý nginx + certbot (repo không làm thay). Trên Ubuntu/Debian:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

**Lấy chứng chỉ** (DNS đã trỏ đúng, cổng 80 mở). Dùng `certonly` để certbot không tự sửa file cấu hình:

```bash
sudo certbot certonly --nginx -d app.example.com --deploy-hook "systemctl reload nginx"
```

Chứng chỉ nằm ở `/etc/letsencrypt/live/app.example.com/` (đúng đường mẫu nginx dùng). certbot tự gia hạn bằng systemd
timer; `--deploy-hook` reload nginx mỗi lần gia hạn. Kiểm: `sudo certbot renew --dry-run`.
Nếu bạn quen dùng webroot: mẫu có sẵn `location /.well-known/acme-challenge/` trỏ `/var/www/letsencrypt` ở khối cổng 80
(`sudo install -d -m 755 /var/www/letsencrypt`, rồi `certbot certonly --webroot -w /var/www/letsencrypt -d app.example.com
--deploy-hook "systemctl reload nginx"` sau khi site đã bật; lần đầu chưa có chứng chỉ thì tạm comment khối `server`
cổng 443 để `nginx -t` qua).

**Cài site từ mẫu** `deploy/nginx.conf.example`:

```bash
cd ~/OnTheTopMoney
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/ottm
sudo sed -i 's/app\.example\.com/<tên-miền-của-bạn>/g' /etc/nginx/sites-available/ottm
# Nếu deploy/.env đổi WEB_ROOT / MEDIA_DIR_HOST / API_HOST_PORT: sửa tương ứng
#   /var/www/ottm/current, /var/lib/ottm/media (cả dòng disable_symlinks), 127.0.0.1:3000
sudo ln -s ../sites-available/ottm /etc/nginx/sites-enabled/ottm
sudo nginx -t && sudo systemctl reload nginx
```

Những điểm **bắt buộc giữ** khi tự chỉnh (đầu file mẫu có danh sách đầy đủ; `deploy/smoke-test.sh` kiểm chúng):

- Các đường `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` (kể cả không có `/…` phía sau) đi tới api;
  `/media/` phục vụ file, thiếu → 404; `/assets/` thiếu → 404; còn lại SPA (`try_files $uri /index.html`).
- `proxy_set_header X-Forwarded-For $remote_addr;` — **không** dùng `$proxy_add_x_forwarded_for` (client tự gửi
  `X-Forwarded-For` giả để né giới hạn đăng nhập). api tin đúng một hop (`TRUST_PROXY=true`).
- Header bảo mật chỉ đặt ở cấp `server` với `always`. Một `add_header` trong `location` làm location đó mất **mọi**
  header của server (quy tắc kế thừa của nginx) — mẫu dùng `map` thay cho add_header trong location.
- `/api/v1/stream` (SSE): `proxy_buffering off`, `proxy_read_timeout` ≥ 1 giờ; không bật gzip trên đường api.
- Không access log cho `/oauth`, `/webhooks` (URL mang `code`, `hub.verify_token`).
- Sau mỗi deploy **không cần reload nginx**: `current` là symlink, nginx đọc theo từng request. Chỉ reload khi sửa
  file cấu hình (`sudo nginx -t && sudo systemctl reload nginx`).

Thứ tự lần đầu: làm mục này **trước** khi deploy — `deploy.sh` kết thúc bằng smoke-test qua `PUBLIC_BASE_URL`, tức là
qua nginx. Trước lần deploy đầu, nginx trả 404 cho web (chưa có `current`) và 502 JSON cho api — bình thường.

### 1.7 Triển khai lần đầu

```bash
cd ~/OnTheTopMoney
./deploy/deploy.sh
```

Script kiểm thư mục (1.5), build image (tag = git SHA ngắn), chép build web ra `WEB_ROOT/<tag>`, ghi `IMAGE_TAG` vào
`deploy/.env`, trỏ `WEB_ROOT/current` sang tag mới, chạy `migrate` rồi `api`, `worker`, chờ `/healthz` (gọi thẳng
`127.0.0.1:API_HOST_PORT`) trả 200, rồi smoke-test qua `PUBLIC_BASE_URL` (nginx). Lần đầu mất vài phút (build).

Kiểm từ máy khác:

```bash
curl -s https://app.example.com/healthz
# {"ok":true,"db":"ok","worker":"ok","disk":"ok"}
./deploy/smoke-test.sh https://app.example.com    # chạy được trên VPS hoặc máy có bash + curl
```

### 1.8 Đặt mật khẩu chủ sở hữu và đăng nhập

```bash
cd ~/OnTheTopMoney/deploy
docker compose run --rm api node scripts/set-password.ts
```

Nhập mật khẩu hai lần (ít nhất 12 ký tự). Đặt lại bất kỳ lúc nào bằng cùng lệnh; mọi phiên cũ bị đăng xuất.
Mở `https://app.example.com` → màn đăng nhập → nhập mật khẩu.

### 1.9 Khởi tạo kho backup và cron

```bash
cd ~/OnTheTopMoney/deploy
docker compose run --rm --entrypoint restic backup init     # một lần duy nhất cho kho mới
docker compose run --rm backup                              # chạy thử một bản
docker compose run --rm --entrypoint restic backup snapshots
```

Cron hằng đêm (cron của máy chủ, giờ theo múi giờ VPS — Ubuntu mặc định UTC; 19:30 UTC = 02:30 giờ Việt Nam):

```bash
crontab -e      # với người dùng deploy
```

**Bắt buộc: báo động khi backup không chạy (dead-man ping).** Backup lỗi không tự báo ai; nếu thiếu bước này,
backup có thể hỏng nhiều tuần mà không ai biết. Tạo một check ở healthchecks.io (hoặc Better Stack heartbeat, Cronitor…):
chu kỳ 1 ngày, grace 2 giờ, gửi báo động qua email/Telegram. Lấy URL ping (vd `https://hc-ping.com/<uuid>`), rồi:

```cron
30 19 * * * cd $HOME/OnTheTopMoney/deploy && docker compose run --rm -T backup >> $HOME/ottm-backup.log 2>&1 && curl -fsS -m 10 --retry 3 https://hc-ping.com/<uuid> > /dev/null
```

Chỉ khi backup thành công mới ping; không nhận ping sau ~26 giờ → dịch vụ báo bạn. Thử ngay: chạy dòng lệnh trên
bằng tay một lần và kiểm check chuyển sang "up".

Xoay vòng log backup (không thì `~/ottm-backup.log` lớn mãi) — tạo `/etc/logrotate.d/ottm-backup`:

```bash
sudo tee /etc/logrotate.d/ottm-backup > /dev/null <<'CONF'
/home/deploy/ottm-backup.log {
    su deploy deploy
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
CONF
sudo logrotate --debug /etc/logrotate.d/ottm-backup     # kiểm cú pháp
```

Mỗi lần backup: `pg_dump -Fc` toàn bộ DB + thư mục media, restic mã hoá trên VPS rồi đẩy lên kho, giữ 14 bản hằng ngày
(`restic forget --keep-daily 14 --prune`), rồi `restic check`. Lỗi bất kỳ → exit ≠ 0 và không xoá bản cũ.

### 1.10 Uptime ping ngoài

Tạo một monitor HTTP ở dịch vụ bên ngoài (UptimeRobot, Better Stack, …):

- URL `https://app.example.com/healthz`, mỗi **5 phút**, báo khi mã khác 200.
- Ý nghĩa khi 503 (xem body JSON):
  - `"db":"down"` — Postgres lỗi: `docker compose ps postgres`, `docker compose logs --tail=100 postgres`.
  - `"worker":"stale"` — worker không ghi heartbeat quá 2 phút: `docker compose logs --tail=100 worker`, `docker compose restart worker`.
  - `"disk":"full"` — đĩa dùng >85%: xem mục 5.
  - `"disk":"unknown"` không gây 503 (không đo được đĩa), nhưng nên xem log api.

### 1.11 Máy đã chạy bản cũ (reverse proxy trong compose, media trong volume Docker)

Chỉ cần nếu VPS từng chạy bản stack có container reverse proxy riêng giữ cổng 80/443 và media trong volume `ottm_media`.
Làm một lần, trước mục 1.6:

```bash
cd ~/OnTheTopMoney/deploy
docker compose down                         # dừng stack cũ, GIỮ volume — giải phóng cổng 80/443 cho nginx
# làm mục 1.5, rồi chép media từ volume cũ sang thư mục máy chủ (ottm-server chạy bằng uid 1000):
docker run --rm -v ottm_media:/from:ro -v /var/lib/ottm/media:/to --entrypoint cp \
  ottm-server:"$(grep '^IMAGE_TAG=' .env | cut -d= -f2-)" -a /from/. /to/
ls /var/lib/ottm/media | head
```

Rồi làm mục 1.6 và `./deploy/deploy.sh`. Khi app chạy ổn: `docker volume rm ottm_media` và xoá image cũ của proxy
(`docker image ls`, `docker image rm <tên>:<tag>`).

---

## 2. Triển khai bản mới

```bash
cd ~/OnTheTopMoney
git pull
./deploy/deploy.sh
```

- Tag image = `git rev-parse --short HEAD`. Có thay đổi chưa commit (kể cả file chưa track trong `server/`, `web/`,
  `packages/`, `deploy/`) thì script dừng (hoặc đặt `IMAGE_TAG=<tên>` để ép).
- Build web được chép ra một thư mục chuẩn bị trong `WEB_ROOT` (`.publish-new-…`, chưa phục vụ) **trước** mọi thay đổi;
  lỗi ở bước này hay ở bước sao lưu → script dừng, dọn thư mục chuẩn bị, `current` và stack giữ nguyên. Ngay trước
  `docker compose up`, bản chuẩn bị mới vào `WEB_ROOT/<tag>` và `current` đổi sang (deploy lại cùng tag cũng thay an
  toàn, `current` không lúc nào trỏ vào thư mục thiếu); sau đó mới ghi `IMAGE_TAG`. nginx thấy bản mới ngay, không cần reload.
- Mỗi lúc chỉ một `deploy.sh`/`rollback.sh` chạy (khoá `deploy/.deploy.lock`, cần `flock`); lần chạy thứ hai dừng ngay.
- Thư mục `.publish-old-…` trong `WEB_ROOT` chỉ còn lại khi thay bản cùng tag lỗi giữa chừng — script cảnh báo, không tự
  xoá; kiểm rồi xoá tay.
- Trước khi chạy bản mới, script sao lưu một bản (`docker compose run backup`) vì migration chỉ tiến. Bỏ qua bằng
  `SKIP_PREDEPLOY_BACKUP=1 ./deploy/deploy.sh` (chỉ khi backup đang hỏng và bạn chấp nhận rủi ro).
- Migration chạy trước api/worker; chỉ tiến, tương thích ngược một phiên bản.
- Script giữ 5 tag gần nhất (`KEEP_TAGS`) — cùng một tập tag cho image và thư mục `WEB_ROOT/<tag>`, không bao giờ xoá
  bản đang `current` — để rollback, và in tag bản trước khi xong. Chỉ thư mục do script tạo (có file `.ottm-web-tag`
  khớp tên) mới bị dọn; thư mục khác trong `WEB_ROOT` không bị đụng.
- `/healthz` (qua `127.0.0.1:API_HOST_PORT`) không lên 200 trong 2 phút, hoặc `smoke-test.sh` qua `PUBLIC_BASE_URL`
  (nginx, DNS, TLS) lỗi → script báo lỗi và in lệnh rollback. Smoke lỗi mà healthz ổn → thường do cấu hình nginx:
  `sudo nginx -t`, `sudo tail -n 50 /var/log/nginx/error.log`. `/healthz` 503 chỉ vì đĩa đầy vẫn cho deploy qua nhưng in CẢNH BÁO — xử lý ngay (mục 5).
- `smoke-test.sh` mặc định không thử đăng nhập (mỗi lần thử sai tốn 1/5 lượt đăng nhập của bạn trong 15 phút);
  `SMOKE_LOGIN=1` để bật.

## 3. Rollback

```bash
docker image ls ottm-server              # các tag còn giữ, mới nhất trước
ls /var/www/ottm                         # các bản web còn giữ (WEB_ROOT)
./deploy/rollback.sh <tag>
```

Không build lại; kiểm có đủ image `ottm-server:<tag>` và thư mục `WEB_ROOT/<tag>` (thiếu → dừng, không đổi gì), rồi
trỏ `WEB_ROOT/current` về `<tag>`, đổi `IMAGE_TAG` trong `deploy/.env` và khởi động lại bằng image cũ.
Migration chỉ tiến: image cũ chạy được trên schema mới hơn **một** phiên bản. Nếu cần lùi qua nhiều bản có đổi schema,
khôi phục backup (mục 4.2) thay vì rollback.

## 4. Sao lưu và khôi phục

### 4.1 Xem bản backup

```bash
cd ~/OnTheTopMoney/deploy
docker compose run --rm --entrypoint restic backup snapshots
tail -n 50 ~/ottm-backup.log
```

### 4.2 Khôi phục trên VPS đang chạy (ghi đè DB và media)

```bash
cd ~/OnTheTopMoney/deploy
docker compose stop api worker
docker compose run --rm restore latest --yes        # hoặc thay latest bằng ID snapshot
docker compose up -d
curl -s https://app.example.com/healthz
```

`restore` kiểm trước khi đụng vào bất cứ thứ gì: không còn phiên của api/worker trên DB (quên `stop` → dừng và báo),
đủ đĩa trống để giải nén snapshot, snapshot có cả dump lẫn media. Sau đó xoá và tạo lại các schema của app
(`public`, `drizzle`, `pgboss`) rồi nạp dump trong **một transaction** (lỗi → DB giữ nguyên), và chỉ khi DB xong mới
đồng bộ media (`rsync --delete-after`). Snapshot không có media → từ chối; chỉ muốn khôi phục DB thì thêm `--db-only`.
Sau khôi phục, `docker compose up -d` chạy lại `migrate`, đưa schema từ thời điểm snapshot lên bản đang chạy.

### 4.3 Khôi phục sang VPS mới (máy cũ mất)

1. Làm mục 1.1–1.6 trên VPS mới, dùng **lại** `deploy/.env` đã cất (cùng `APP_ENCRYPTION_KEYS`, `RESTIC_*`).
   Đổi DNS sang IP mới (trước khi lấy chứng chỉ ở 1.6).
2. `./deploy/deploy.sh` (tạo DB rỗng và chạy stack).
3. Mục 4.2 (stop api worker → restore → up).
4. Không chạy `restic init` (kho đã có). Bật lại cron (1.9) và uptime ping (1.10).

### 4.4 Diễn tập khôi phục (trước go-live và mỗi quý)

Khôi phục vào database phụ, không đụng dữ liệu đang chạy:

```bash
cd ~/OnTheTopMoney/deploy
docker compose exec postgres createdb -U ottm ottm_drill
docker compose run --rm \
  -e RESTORE_DATABASE_URL="postgres://ottm:$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)@postgres:5432/ottm_drill" \
  -e RESTORE_MEDIA_DIR=/tmp/drill-media \
  restore latest --yes
docker compose exec postgres psql -U ottm -d ottm_drill -c '\dt'
docker compose exec postgres dropdb -U ottm ottm_drill
```

Ghi lại ngày diễn tập và thời gian khôi phục.

## 5. Vận hành hằng ngày

### Log

```bash
cd ~/OnTheTopMoney/deploy
docker compose ps
docker compose logs -f --tail=100 api worker
docker compose logs --tail=100 migrate postgres
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log      # nginx (theo cấu hình của bạn)
```

Log JSON (pino), xoay vòng tự động 10 MB × 5 file mỗi service. Log không chứa mật khẩu, token, cookie.
Log nginx do logrotate của gói nginx xoay. Mẫu nginx tắt access log cho `/oauth`, `/webhooks` (URL có thể mang mã bí
mật) và chỉ ghi lỗi mức `crit` ở đó; đừng bật lại.

### Khởi động lại / dừng

```bash
docker compose restart api worker
docker compose down          # dừng tất cả, GIỮ dữ liệu
# KHÔNG chạy `docker compose down -v` trên production: -v xoá volume pgdata (toàn bộ DB).
# (media nằm ở thư mục máy chủ MEDIA_DIR_HOST, không bị -v xoá — đừng xoá tay thư mục đó.)
```

### Đĩa đầy (`/healthz` báo `"disk":"full"`)

`/healthz` tính `1 − bavail / blocks` trên đĩa chứa volume (`statfs`), tức tính cả phần ext4 dành riêng cho root
(thường 5%) là "đã dùng". Vì vậy con số của healthz cao hơn cột `Use%` của `df` (df tính `used / (used + avail)`):
healthz báo 85% khi `df -h /` chỉ khoảng 80–84%. Để xem đúng con số healthz dùng:

```bash
stat -f -c '%b %a' / | awk '{ printf "healthz dùng: %.1f%%\n", (1 - $2 / $1) * 100 }'
```

```bash
df -h /
docker system df
docker image prune -f                    # image không còn tag
docker builder prune -f --keep-storage 5GB
```

Nếu vẫn đầy: xem kích thước volume (`docker system df -v`), media (`sudo du -sh /var/lib/ottm/media`), các bản web
(`du -sh /var/www/ottm/*`, giảm `KEEP_TAGS`), nâng dung lượng đĩa VPS.

### Đổi mật khẩu chủ sở hữu

`docker compose run --rm api node scripts/set-password.ts` (mục 1.8).

### Chứng chỉ TLS

certbot tự gia hạn (systemd timer `certbot.timer`; xem `systemctl list-timers | grep certbot`), chứng chỉ ở
`/etc/letsencrypt/live/<tên miền>/`, và `--deploy-hook` (mục 1.6) reload nginx sau mỗi lần gia hạn. Kiểm định kỳ:
`sudo certbot renew --dry-run`. Lỗi gia hạn: `sudo journalctl -u certbot` hoặc `/var/log/letsencrypt/letsencrypt.log` —
thường do DNS chưa trỏ đúng hoặc cổng 80 bị chặn.

## 6. Meta Test App cho dev

Dev **không bao giờ** dùng app Meta production. Mỗi dev có một **Meta Test App** (Facebook + Instagram) và một
**Threads test app** riêng, callback trỏ về tunnel tới máy mình. Production từ chối khởi động khi
`META_APP_ENV=test`, còn dev thì dùng `META_APP_ENV=test`.

> **Cảnh báo:** không sửa Valid OAuth Redirect URIs, Redirect Callback URLs hay Webhooks của **app production**
> để thử ở máy dev. Đổi callback của app production thì người dùng thật bị chuyển về máy dev và đăng nhập hỏng.
> Mọi thay đổi ở mục này chỉ làm trên Test App / Threads test app.

### 6.1 Tạo Meta Test App (Facebook Page + Instagram Business)

Cần quyền Admin trên app chính ở <https://developers.facebook.com/apps>.

1. Mở app chính → bấm tên app ở góc trên bên trái → **Create test app**. Đặt tên dạng `OnTheTopMoney Dev <tên bạn>`.
   Test App luôn ở chế độ Development, có App ID và App Secret riêng, và chép cấu hình của app chính lúc tạo
   ([Test Apps](https://developers.facebook.com/docs/development/build-and-test/test-apps/)).
2. Vào Test App → **App settings › Basic**: ghi lại **App ID** và **App Secret** (bấm Show). App Secret là bí mật:
   chỉ đặt trong `server/.env` (đã gitignore), không dán vào chat hay issue.
3. **Use cases**: kiểm Test App có các use case giống app chính — Facebook Login for Business, quản lý Page,
   Messenger, Instagram API with Facebook Login. Thiếu cái nào thì **Add use case** cho đủ. Trong Development
   mode, mọi quyền (`pages_*`, `instagram_*`, `business_management`, `read_insights`…) dùng được với người có vai
   trò trên app mà không cần App Review.
4. **Facebook Login for Business › Settings › Valid OAuth Redirect URIs**: thêm
   `https://<tunnel>/oauth/facebook/callback` (`<tunnel>` lấy ở mục 6.4; đúng bằng `PUBLIC_BASE_URL` +
   `/oauth/facebook/callback`, production là `https://<tên miền>/oauth/facebook/callback`). Bật **Client OAuth
   login** và **Web OAuth login**, bật **Enforce HTTPS**. Bấm **Save changes**.
   Tuỳ chọn: **Facebook Login for Business › Configurations › Create configuration** (loại *User access token*,
   chọn đủ quyền ở mục 6.6) rồi đặt Configuration ID vào `META_LOGIN_CONFIG_ID`. Không đặt thì app tự gửi danh
   sách quyền qua `scope`.
5. Webhooks (dùng từ Epic 4): **Webhooks** → Page / Instagram → callback `https://<tunnel>/webhooks/meta`,
   verify token = giá trị `META_VERIFY_TOKEN` trong `server/.env` (`openssl rand -hex 16`).

### 6.2 Thêm tester cho Test App

App ở Development mode chỉ cho người có vai trò đăng nhập và chỉ nhận webhook từ họ
([App Roles](https://developers.facebook.com/docs/development/build-and-test/app-roles/)).

1. Test App → **App roles › Roles** → **Add people** → vai trò **Tester** (hoặc Developer) → nhập tài khoản Facebook.
2. Người được mời chấp nhận tại <https://developers.facebook.com/requests/>.
3. Tài khoản tester phải là **admin của một Fanpage thử** (tạo Fanpage riêng, đừng dùng trang của khách). Muốn
   thử Instagram: chuyển một tài khoản IG thử sang **Business**, rồi liên kết nó với Fanpage thử (Meta Business
   Suite › Settings › Instagram accounts). IG cá nhân hoặc chưa liên kết Fanpage thì app không chọn được.

### 6.3 Tạo Threads test app

Threads dùng OAuth riêng, có Threads App ID/secret riêng ([Threads API — Get started](https://developers.facebook.com/docs/threads/get-started)).

1. <https://developers.facebook.com/apps> → **Create app** → chọn use case **Access the Threads API** → đặt tên
   `OnTheTopMoney Threads Dev <tên bạn>`. Giữ app ở Development mode (không bấm Publish/Go live).
2. **Use cases › Access the Threads API › Customize**: bật các quyền `threads_basic`, `threads_content_publish`,
   `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights`.
3. **Use cases › Access the Threads API › Settings**: ghi lại **Threads App ID** và **Threads app secret**
   (KHÔNG phải App ID/App Secret ở App settings › Basic). Thêm **Redirect Callback URLs**:
   `https://<tunnel>/oauth/threads/callback` (đúng bằng `PUBLIC_BASE_URL` + `/oauth/threads/callback`; production là
   `https://<tên miền>/oauth/threads/callback` ở Threads app production). Uninstall Callback URL: `https://<tunnel>/oauth/threads/uninstall`;
   Delete Callback URL: `https://<tunnel>/oauth/threads/delete` (đường dẫn giữ chỗ, route dựng ở story sau — tới
   lúc đó Meta gọi vào sẽ nhận 404, không ảnh hưởng thử OAuth). Bấm **Save**.
4. Thêm tester: **App roles › Roles** → **Add people** → **Threads Tester** → nhập username Threads. Người được mời
   chấp nhận trong Threads: **Settings › Account › Website permissions › Invites**.

### 6.4 Tunnel cho callback dev (cloudflared)

Meta chỉ gọi callback qua HTTPS công khai, nên cần tunnel từ internet về **Vite ở cổng 5173**. Vite phục vụ web và
proxy `/api`, `/healthz`, `/oauth`, `/webhooks` sang api (cổng 3000), nên qua tunnel có cùng một origin như
production sau nginx
([Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)).

```bash
brew install cloudflared                          # macOS; Linux: xem link ở trên
npm run dev                                       # terminal 1, ở gốc repo (web 5173, api 3000)
cloudflared tunnel --url http://localhost:5173    # terminal 2
# in ra: https://<tên-ngẫu-nhiên>.trycloudflare.com  ← đây là <tunnel>
curl -s https://<tên-ngẫu-nhiên>.trycloudflare.com/healthz   # terminal 3: phải ra JSON {"ok":true,...}
```

Vite chỉ nhận host `*.trycloudflare.com`; với named tunnel (dưới đây) chạy `DEV_TUNNEL_HOSTS=<host> npm run dev`
(vd `DEV_TUNNEL_HOSTS=dev-<tên-bạn>.example.com`), nếu không Vite trả "Blocked request".

Quick tunnel **đổi URL mỗi lần chạy**: mỗi lần mở lại phải sửa `PUBLIC_BASE_URL` (mục 6.5) và các callback ở mục
6.1 bước 4–5, 6.3 bước 3. Muốn URL cố định: dùng named tunnel trên một tên miền đã ở Cloudflare
([Create a tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)):

```bash
cloudflared tunnel login
cloudflared tunnel create ottm-dev
cloudflared tunnel route dns ottm-dev dev-<tên-bạn>.example.com
cloudflared tunnel run --url http://localhost:5173 ottm-dev
```

**Khi thử OAuth, mở app qua `https://<tunnel>`, không qua `http://localhost:5173`.** Cookie phiên và cookie `state`
của OAuth gắn với host đã đặt chúng: cookie đặt trên `localhost` không được gửi tới host tunnel, nên đăng nhập ở
localhost rồi để Meta chuyển về `https://<tunnel>/oauth/...` thì callback không thấy phiên/`state` và báo lỗi.
Mở `https://<tunnel>`, đăng nhập lại ở đó, rồi bấm "Kết nối tài khoản". Muốn vậy cần (mục 6.5):

- `ALLOWED_ORIGINS` có origin tunnel. Đặt biến này là **thay** danh sách mặc định, nên ghi cả localhost:
  `ALLOWED_ORIGINS=https://<tunnel>,http://localhost:5173,http://localhost:5174`. Thiếu → mọi thao tác ghi qua
  tunnel bị 403.
- `COOKIE_SECURE` để mặc định `true`: tunnel là HTTPS nên cookie `Secure` hoạt động. Nếu trước đó bạn đặt
  `COOKIE_SECURE=false` cho localhost thì vẫn chạy được qua tunnel, nhưng đừng đặt `false` chỉ vì tunnel.

### 6.5 Biến `.env` dev

Thêm vào `server/.env` (xem `server/.env.example`), rồi khởi động lại `npm run dev`:

```dotenv
# origin tunnel, không dấu / cuối
PUBLIC_BASE_URL=https://<tunnel>
ALLOWED_ORIGINS=https://<tunnel>,http://localhost:5173,http://localhost:5174
# App ID của Test App — KHÔNG dùng App ID của app production
META_APP_ID=<App ID của Test App>
META_APP_ENV=test
META_APP_SECRET=<App Secret của Test App>
# ít nhất 16 ký tự: openssl rand -hex 16
META_VERIFY_TOKEN=<chuỗi ngẫu nhiên>
# mặc định v26.0; chỉ đổi khi cả nhóm nâng phiên bản
META_GRAPH_VERSION=v26.0
# đặt cả hai hoặc không đặt cái nào (thiếu một → api không khởi động)
THREADS_APP_ID=<Threads App ID của Threads test app>
THREADS_APP_SECRET=<Threads app secret của Threads test app>
THREADS_APP_ENV=test
```

Kiểm cặp App ID / App Secret. Lệnh chạy trong subshell, chỉ đọc ba biến cần dùng (không export cả `.env` vào
shell), và đưa URL chứa secret cho curl qua stdin (`-K -`) nên secret không nằm trong danh sách tiến trình hay
lịch sử lệnh. Kết quả là app token: lệnh chỉ in OK/SAI, đừng sửa để in token.

```bash
(
  get() { sed -n "s/^$1=//p" server/.env | tail -n 1 | sed 's/[[:space:]]#.*$//; s/^"\(.*\)"$/\1/'; }
  v=$(get META_GRAPH_VERSION); v=${v:-v26.0}
  printf 'url = "https://graph.facebook.com/%s/oauth/access_token?client_id=%s&client_secret=%s&grant_type=client_credentials"\n' \
    "$v" "$(get META_APP_ID)" "$(get META_APP_SECRET)" \
    | curl -s -K - | grep -q '"access_token"' && echo "Meta Test App: OK" || echo "Meta Test App: SAI"
)
```

Ra `OK` là xong. Ra `SAI` → chép nhầm App ID/secret (hoặc lấy secret của app production).
Api không khởi động mà log nêu `META_GRAPH_VERSION` → giá trị phải dạng `vNN.N`.

### 6.6 Thử luồng kết nối Fanpage + Instagram

Quyền app xin (Facebook Login for Business): `pages_show_list`, `business_management`, `pages_messaging`,
`pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`,
`pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`,
`instagram_content_publish`, `instagram_manage_insights`. Trang nào thiếu một quyền bắt buộc (đọc theo từng trang từ
`granular_scopes`) thì không chọn được và app hiện "Chưa cấp đủ quyền quản lý tin nhắn".

**Không cần app Meta — Meta giả.** Đặt `META_FAKE=1` trong `server/.env` (không cần `META_APP_ID`, tunnel hay
`PUBLIC_BASE_URL`), chạy `npm run dev`, mở `http://localhost:5173`, đăng nhập, vào **Trang & Nhóm › + Kết nối tài
khoản › Facebook Fanpage**. App mở trang đồng ý giả cục bộ `/oauth/facebook/fake-consent`:

- **Đồng ý** → quay về bước chọn trang với 2 Fanpage giả: một có IG Business liên kết, một có IG chưa phải Business
  (bị khoá, kèm dòng "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage").
- Tích **Bỏ quyền tin nhắn** rồi Đồng ý → modal "Chưa cấp đủ quyền quản lý tin nhắn" + danh sách quyền thiếu.
- **Huỷ** → thông báo "Bạn đã huỷ kết nối" + "Thử lại".

Production từ chối khởi động khi `META_FAKE` bật.

**Với Meta Test App.** Làm đủ 6.1–6.5, mở app qua `https://<tunnel>` rồi bấm cùng nút. Meta chuyển về
`https://<tunnel>/oauth/facebook/callback`; callback chỉ nhận khi cookie phiên của trình duyệt khớp phiên đã bấm
"Kết nối" (`state` sống 15 phút, dùng một lần), nếu không app báo "Phiên kết nối đã hết hạn hoặc không hợp lệ".

### 6.7 Thử luồng kết nối Threads

Threads là tài khoản OAuth riêng (app Threads riêng, không gộp vào tài khoản Facebook). App mở cửa sổ đồng ý
`https://threads.com/oauth/authorize` với quyền `threads_basic`, `threads_content_publish`, `threads_read_replies`,
`threads_manage_replies`, `threads_manage_insights` (cả năm bắt buộc). Callback `/oauth/threads/callback` bỏ hậu tố
`#_` khỏi `code`, đổi token ngắn hạn (`POST https://graph.threads.com/oauth/access_token`) sang token dài hạn 60 ngày
(`GET https://graph.threads.com/access_token?grant_type=th_exchange_token`), đọc quyền bằng `debug_token` (app token
`TH|<THREADS_APP_ID>|<THREADS_APP_SECRET>`, kiểm `app_id`) và hồ sơ `/v1.0/me`. Token lưu mã hoá kèm `expires_at`.
Thiếu `THREADS_APP_ID`/`THREADS_APP_SECRET` (và không bật Meta giả) → nút Threads báo `META_NOT_CONFIGURED`.

**Threads giả.** Với `META_FAKE=1`, vào **Trang & Nhóm › + Kết nối tài khoản › Threads** (hoặc Màn chào bước 1,
hoặc Cài đặt › Tài khoản Meta › Kết nối Threads — callback đưa về đúng màn đã bấm). App mở trang đồng ý giả
`/oauth/threads/fake-consent` (gửi về callback với fragment `#_` như Threads thật; callback trả Location kết thúc
bằng `#` để trình duyệt không giữ `#_`):

- **Đồng ý** → bước chọn với tài khoản `@lananh.threads` → xác nhận → bảng Trang & Nhóm có trang Threads "Đang hoạt
  động"; Cài đặt › Tài khoản Meta hiện nó ở khối **Threads**, tách khỏi khối Facebook (Fanpage + Instagram).
- Tích **Bỏ quyền trả lời** rồi Đồng ý → modal "Chưa cấp đủ quyền Threads" + `threads_read_replies`,
  `threads_manage_replies` + "Thử lại".
- **Huỷ** → "Bạn đã huỷ kết nối" + "Thử lại".

**Với Threads test app.** Làm 6.3–6.5, mở app qua `https://<tunnel>`, đăng nhập bằng tài khoản Threads đã nhận lời
mời tester. Muốn thêm tài khoản Threads thứ hai: trước khi bấm "Kết nối Threads", chuyển sang tài khoản
Threads/Instagram đó trên trình duyệt (hoặc đăng xuất tài khoản đang dùng) — cửa sổ Threads cấp quyền cho tài khoản
đang đăng nhập. Chưa có làm mới token Threads (Story 2.4) hay webhook Threads (Epic 4); Uninstall/Delete callback là
Story 9.1.

Tài liệu Meta liên quan: [Graph API v26.0 changelog](https://developers.facebook.com/docs/graph-api/changelog/version26.0),
[Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/),
[Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/),
[Threads — get access tokens](https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions),
[Threads long-lived tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens),
[Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started).

### 6.8 Thử web và api khác origin trên máy dev (giống chế độ tách)

Dev thường dùng proxy Vite (cùng origin). Muốn thử đúng mô hình mục 8 (web gọi api ở origin khác, CORS + cookie):

```dotenv
# server/.env — api ở 3000 (host api), web là vite preview 4173 (host web); cookie không Secure vì http
PUBLIC_BASE_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:4173,http://localhost:5173
WEB_BASE_URL=http://localhost:4173
COOKIE_SECURE=false
META_FAKE=1
```

`PUBLIC_BASE_URL=http://localhost:3000` là bắt buộc ở đây: không đặt thì mặc định là Vite `http://localhost:5173`, trang
đồng ý giả và callback OAuth sẽ đi qua proxy của Vite chứ không gọi thẳng host api như production chế độ tách.

```bash
npm run dev                                                             # api 3000 (+ Vite 5173, không dùng)
VITE_API_ORIGIN=http://localhost:3000 npm run build -w web && npm run preview -w web -- --port 4173 --strictPort
```

Mở `http://localhost:4173`, đăng nhập, xem SSE (dải "Đang kết nối lại…" không hiện), kết nối Facebook giả: trang đồng
ý giả mở thẳng ở host api `http://localhost:3000/oauth/facebook/fake-consent`, Đồng ý → callback
`http://localhost:3000/oauth/facebook/callback` → chuyển về host web `http://localhost:4173/trang-nhom?ket-noi=…`.
Xong thì bỏ các dòng trên khỏi `server/.env` để quay lại dev thường (Vite 5173 cùng origin).
`localhost:4173` và `localhost:3000` cùng site (cookie không phân biệt cổng), nên cookie `ottm_sid` đi kèm như giữa
`app.example.com` và `api.example.com`. Build chỉ nhận `VITE_API_ORIGIN` http cho localhost/127.0.0.1/[::1].

## 7. Tóm tắt lệnh

| Việc | Lệnh (trong `deploy/` trừ khi ghi khác) |
|---|---|
| Deploy | `git pull && ./deploy/deploy.sh` (ở gốc repo) |
| Rollback | `./deploy/rollback.sh <tag>` (ở gốc repo) |
| Kiểm / nạp lại nginx | `sudo nginx -t && sudo systemctl reload nginx` (chỉ khi sửa cấu hình nginx) |
| Đặt mật khẩu | `docker compose run --rm api node scripts/set-password.ts` |
| Backup ngay | `docker compose run --rm backup` |
| Xem snapshot | `docker compose run --rm --entrypoint restic backup snapshots` |
| Khôi phục | `docker compose stop api worker && docker compose run --rm restore latest --yes && docker compose up -d` |
| Kiểm nhanh | `curl -s https://app.example.com/healthz` hoặc `./deploy/smoke-test.sh https://app.example.com` |
| Log | `docker compose logs -f --tail=100 api worker` |
| Xuất bản web (chế độ tách) | `VITE_API_ORIGIN=https://api.example.com HOSTINGER_SSH=… HOSTINGER_PATH=… ./deploy/hostinger/publish-web-hostinger.sh` (ở gốc repo, mục 8.4) |
| Kiểm web (chế độ tách) | `./deploy/hostinger/check-htaccess.sh https://app.example.com https://api.example.com` (ở gốc repo) |
| Kiểm host api (chế độ tách) | `SMOKE_MODE=api ORIGIN=https://app.example.com ./deploy/smoke-test.sh https://api.example.com` (ở gốc repo) |

## 8. Chế độ tách: web trên Hostinger

Chế độ thứ hai (`WEB_MODE=external`): web tĩnh (`web/dist`) nằm trên hosting Hostinger (Apache/LiteSpeed, `.htaccess`),
VPS chỉ chạy BE (api, worker, migrate, Postgres, backup) sau nginx cho một **host api** riêng.

```
Trình duyệt ──https──> app.example.com  (Hostinger: web/dist + .htaccess)
     │
     └──https (fetch/SSE, credentials: include, CORS)──> api.example.com  (VPS: nginx → 127.0.0.1:3000 → api)
                                                           └──> /media (MEDIA_DIR_HOST)
```

### 8.1 Điều kiện bắt buộc

- **Cùng tên miền gốc**: web và api phải là hai tên con của cùng một miền (`app.example.com` + `api.example.com`).
  Cookie phiên `ottm_sid` (HttpOnly; Secure; SameSite=Lax; host-only, không `Domain`) do host api đặt; trình duyệt
  chỉ gửi nó kèm request từ web khi hai host **cùng site**. Khác tên miền gốc (`shop-abc.com` → `api-xyz.net`) thì
  Safari/Chrome coi là cookie bên thứ ba và chặn — **đăng nhập không chạy**, không sửa được bằng cấu hình.
- `server` (api) bật CORS có credentials cho đúng các origin trong `ALLOWED_ORIGINS` (so khớp chính xác, không `*`,
  luôn `Vary: Origin`, chỉ `/api/v1/*`); kiểm Origin của request ghi giữ nguyên (origin lạ → 403).
- Web build với `VITE_API_ORIGIN=https://api.example.com` (origin api nhúng vào bundle và vào CSP của `.htaccess`).

### 8.2 VPS (BE)

1. DNS: `api.example.com` → IP VPS (mục 1.2, thay `app` bằng `api`). Tên web (`app.example.com`) trỏ về Hostinger
   theo hPanel.
2. `deploy/.env` (mục 1.4), thêm/sửa:

   ```dotenv
   WEB_MODE=external
   PUBLIC_BASE_URL=https://api.example.com      # host api: OAuth callback, webhook, /media
   WEB_BASE_URL=https://app.example.com         # host web: OAuth xong chuyển chủ shop về đây
   ALLOWED_ORIGINS=https://app.example.com      # origin web (phẩy ngăn cách nếu nhiều), phải gồm WEB_BASE_URL
   ```

   `WEB_ROOT` không dùng (để nguyên hay xoá đều được). `deploy.sh`/`rollback.sh` kiểm trước khi build, sao lưu hay
   đổi gì: `WEB_BASE_URL` phải là origin https, khác `PUBLIC_BASE_URL` và nằm trong `ALLOWED_ORIGINS` (sai → dừng,
   nêu tên biến). Ngược lại, `WEB_MODE=vps` mà còn `WEB_BASE_URL` khác `PUBLIC_BASE_URL` cũng bị từ chối.
3. Thư mục: chỉ cần thư mục media (mục 1.5, bỏ phần `/var/www/ottm`).
4. nginx: dùng mẫu **`deploy/nginx-api.conf.example`** thay cho `nginx.conf.example`. Theo đúng thứ tự của mục 1.6:
   **lấy chứng chỉ trước** (DNS của host api đã trỏ đúng, cổng 80 mở), rồi mới bật site và `nginx -t` (site tham
   chiếu file chứng chỉ, chưa có thì `nginx -t` lỗi):

   ```bash
   sudo certbot certonly --nginx -d api.example.com --deploy-hook "systemctl reload nginx"
   sudo certbot renew --dry-run
   ```

   Rồi cài site và sửa **mọi** giá trị mẫu cho khớp `deploy/.env`:

   | Trong mẫu | Thay bằng |
   |---|---|
   | `api.example.com` (server_name, đường chứng chỉ, redirect) | host của `PUBLIC_BASE_URL` |
   | `/var/lib/ottm/media` (cả dòng `alias` và `disable_symlinks`) | `MEDIA_DIR_HOST` |
   | `127.0.0.1:3000` (`upstream ottm_api_upstream`) | `127.0.0.1:<API_HOST_PORT>` |
   | `/var/www/letsencrypt` (khối cổng 80) | thư mục webroot certbot, chỉ khi dùng `certbot certonly --webroot` |

   ```bash
   cd ~/OnTheTopMoney
   sudo cp deploy/nginx-api.conf.example /etc/nginx/sites-available/ottm-api
   sudo sed -i 's/api\.example\.com/<host-api-của-bạn>/g' /etc/nginx/sites-available/ottm-api
   # MEDIA_DIR_HOST / API_HOST_PORT khác mặc định → sửa tay /var/lib/ottm/media và 127.0.0.1:3000 trong file
   sudo ln -s ../sites-available/ottm-api /etc/nginx/sites-enabled/ottm-api
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Mẫu này: `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` → api (SSE `/api/v1/stream` không đệm); `/media/` từ
   `MEDIA_DIR_HOST`; `/` và đường lạ → JSON 404 (host api không phục vụ trang web); CSP `default-src 'none'`;
   **không** thêm header `Access-Control-*` ở nginx (api tự đặt — thêm `*` ở nginx sẽ làm hỏng đăng nhập). Tên
   map/upstream có tiền tố `ottm_api_` nên cài song song được với site cùng VPS lúc chuyển chế độ.
5. `./deploy/deploy.sh` — với `WEB_MODE=external` script bỏ qua build/xuất bản web (`Dockerfile.web`, `WEB_ROOT`),
   chỉ build BE, chạy stack, chờ `/healthz`, rồi smoke-test host api (`SMOKE_MODE=api`, `Origin` = `WEB_BASE_URL`:
   preflight CORS, `/` → JSON 404, header, `/media`). `rollback.sh` cũng chỉ quay BE.
6. App Meta/Threads production: Redirect URI là `https://api.example.com/oauth/facebook/callback` và
   `https://api.example.com/oauth/threads/callback`, webhook `https://api.example.com/webhooks/meta` (mục 6.1, 6.3 —
   trên app **production**).
7. Uptime ping (mục 1.10): `https://api.example.com/healthz` và thêm một monitor cho `https://app.example.com/`.

### 8.3 Hostinger (web)

- hPanel: thêm tên miền/subdomain web vào gói hosting, bật SSL (Security › SSL), bật SSH và thêm public key của máy
  sẽ chạy script (Advanced › SSH Access; Hostinger dùng cổng SSH riêng, thường `65002`).
- `.htaccess` sinh lúc build từ `deploy/hostinger/htaccess.template` (chỉ khi đặt `VITE_API_ORIGIN`; build cùng
  origin cho chế độ VPS không sinh `.htaccess`):
  - HTTP → HTTPS (bỏ qua `localhost` để thử cục bộ);
  - SPA fallback: đường không phải file thật (`/trang-nhom/abc`) → `index.html` 200; `assets/` thiếu file → 404
    (không trả HTML thay JS); file ẩn → 404; không liệt kê thư mục (`Options -Indexes`);
  - header: CSP (`connect-src 'self' <api>`, `img-src 'self' data: blob: <api> …`, `frame-ancestors 'none'`), HSTS,
    `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`;
  - cache: `assets/*` `public, max-age=31536000, immutable`; còn lại (`index.html`…) `no-cache`; tắt `mod_expires`;
    gzip nếu có `mod_deflate`.
  - Mọi khối bọc `<IfModule>`: thiếu module thì site vẫn chạy (chỉ mất tính năng đó) — luôn kiểm sau khi upload (8.5).

### 8.4 Xuất bản web

Chạy ở máy có mã nguồn + Node 24 + `rsync`/`ssh` (máy dev, hoặc chính VPS sau `npm ci`):

```bash
cd ~/OnTheTopMoney
git pull
VITE_API_ORIGIN=https://api.example.com \
HOSTINGER_SSH=u123456789@<ip-hoặc-host-ssh> HOSTINGER_SSH_PORT=65002 \
HOSTINGER_PATH=domains/app.example.com/public_html \
WEB_BASE_URL=https://app.example.com \
  ./deploy/hostinger/publish-web-hostinger.sh
```

Script build web (dừng nếu `VITE_API_ORIGIN` sai dạng: có path, không https), kiểm `dist/.htaccess` và bundle mang
đúng origin api, rồi rsync qua SSH theo thứ tự `assets/` → file gốc + `.htaccess` → `index.html` (trình duyệt không
bao giờ thấy `index.html` mới trỏ tới asset chưa lên). **Không xoá file nào** trên hosting. Có `WEB_BASE_URL` thì cuối
cùng chạy `deploy/hostinger/check-htaccess.sh`.

- `--prune-assets`: sau khi `index.html` mới đã lên, xoá trong `assets/` các file không thuộc bản build này (bản cũ).
  Tab còn mở bản cũ sẽ lỗi khi tải chunk cũ (tải lại trang là xong) — chỉ dọn khi bản mới đã chạy ổn.
- Không có SSH: bỏ `HOSTINGER_SSH` — script chỉ build rồi in hướng dẫn upload bằng hPanel › Files › File Manager
  (bật "Show hidden files" để thấy `.htaccess`; `assets/` trước, `index.html` cuối).
- BE và web xuất bản riêng. Thay đổi cần cả hai (API mới mà web gọi): deploy BE trước (API tương thích ngược), rồi web.
  Rollback BE không đổi web; cần web cũ thì `git checkout <commit>` và chạy lại script.

### 8.5 Kiểm và xử lý sự cố

```bash
./deploy/hostinger/check-htaccess.sh https://app.example.com https://api.example.com
SMOKE_MODE=api ORIGIN=https://app.example.com ./deploy/smoke-test.sh https://api.example.com
```

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Deep link (`/trang-nhom`) trả 404 của Hostinger | `.htaccess` chưa lên (file ẩn — bật "Show hidden files") hoặc nằm sai thư mục |
| Thiếu header bảo mật / `Cache-Control` | hosting tắt `mod_headers` (hiếm) — hỏi hỗ trợ Hostinger |
| "Không kết nối được máy chủ" ở màn đăng nhập | DevTools › Console: lỗi CORS → `ALLOWED_ORIGINS` thiếu/sai origin web (đúng `https`, đúng `www`, không `/` cuối); lỗi CSP `connect-src` → web build với `VITE_API_ORIGIN` khác host api |
| Đăng nhập xong vẫn bị đá về màn đăng nhập | cookie `ottm_sid` không đi kèm: web và api khác tên miền gốc (8.1), hoặc trình duyệt chặn cookie; xem `Set-Cookie` của `POST /api/v1/auth/login` ở tab Network |
| Kết nối Meta xong về sai trang | `WEB_BASE_URL` sai — sửa `deploy/.env`, `./deploy/deploy.sh` |
| "Đang kết nối lại…" mãi | SSE `https://api.example.com/api/v1/stream` bị chặn: tab Network (CORS? 401?), cấu hình SSE của nginx-api |

### 8.6 Chuyển từ chế độ cùng VPS sang tách

1. Cài site api song song site cũ (8.2 bước 1, 4); thêm tên web vào Hostinger và bật SSL ở đó (8.3).
2. Sửa `deploy/.env` (8.2 bước 2), `./deploy/deploy.sh` (8.2 bước 5); đổi callback/webhook ở app Meta/Threads
   production (8.2 bước 6). Từ đây OAuth đi qua host api.
3. Xuất bản web lên Hostinger (8.4) **không** đặt `WEB_BASE_URL` cho script (chưa kiểm được vì tên web còn trỏ VPS).
   Muốn xem trước: kiểm bằng tên tạm/xem trước Hostinger cấp trong hPanel —
   `./deploy/hostinger/check-htaccess.sh https://<tên-tạm> https://api.example.com` (đăng nhập qua tên tạm thì không
   chạy: tên tạm không cùng tên miền gốc và không nằm trong `ALLOWED_ORIGINS`).
4. Trỏ DNS của tên web sang Hostinger, chờ DNS lan và SSL của Hostinger cấp xong (`curl -sI https://app.example.com`
   ra chứng chỉ hợp lệ). **Chỉ sau đó** kiểm 8.5 trên tên thật.
5. Lúc chuyển, **mọi người bị đăng xuất một lần**: cookie `ottm_sid` cũ do host web cũ (cùng VPS) đặt, chỉ gửi tới
   host đó; host api mới không nhận được nó → đăng nhập lại ở `https://app.example.com`.
6. Khi ổn: gỡ site `nginx.conf.example` cũ, xoá `WEB_ROOT` (`/var/www/ottm`) và image `ottm-web` cũ
   (`docker image rm $(docker image ls ottm-web -q)`).

Quay lại chế độ VPS: `WEB_MODE=vps`, bỏ `WEB_BASE_URL` / `ALLOWED_ORIGINS` (hoặc đặt = `PUBLIC_BASE_URL` của tên miền
chung — `deploy.sh` từ chối `WEB_BASE_URL` khác `PUBLIC_BASE_URL` khi `WEB_MODE=vps`), cài lại site
`nginx.conf.example`, `./deploy/deploy.sh`.
