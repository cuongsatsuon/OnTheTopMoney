# Runbook vận hành OnTheTopMoney (một VPS, Docker Compose)

Tài liệu này đủ để dựng app trên một VPS mới, triển khai, quay lại bản cũ và sao lưu tay mà không cần đọc mã.
Mọi lệnh `docker compose …` chạy trong thư mục `deploy/` của repo trên VPS (ví dụ `~/OnTheTopMoney/deploy`).

## Kiến trúc trong một hình

```
Internet ──80/443──> nginx (máy chủ, bạn tự quản, TLS certbot, header bảo mật)
                       ├──> 127.0.0.1:3080 ──> web (docker compose: nginx trong container phục vụ build web)
                       └──> 127.0.0.1:3000 ──> api (docker compose) ──> postgres
                                                  └──> (Meta, OpenAI, Cloudinary)   worker ──> postgres
Ảnh/file ──> Cloudinary (ảnh công khai: https://res.cloudinary.com/…; file riêng tư: chỉ server tải qua API có chữ ký)
```

**Không có backup tự động.** Không có gì tự sao lưu DB: VPS hỏng/mất là mất dữ liệu từ lần `pg_dump` tay gần nhất
(mục 4). Tự quyết lịch sao lưu tay và nơi cất file dump (ngoài VPS).

Đây là chế độ mặc định `COMPOSE_PROFILES=web` (web + api cùng VPS, cùng tên miền). Chế độ thứ hai — web tĩnh trên
Hostinger, VPS chỉ chạy BE (`COMPOSE_PROFILES=` để trống) — xem mục 8; các mục 1–7 vẫn áp dụng, trừ chỗ mục 8 ghi khác.

nginx và certbot **không** nằm trong stack: bạn cài và quản lý chúng trên máy chủ (mục 1.6). Repo chỉ đưa mẫu
cấu hình `deploy/nginx.conf.example`; docker compose không cài, không sửa, không reload nginx.

| Thành phần | Vai trò | Cổng |
|---|---|---|
| nginx (máy chủ) | HTTPS, chuyển `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` tới api và mọi đường còn lại tới `web`, header bảo mật | 80, 443 (ra internet) |
| `web` | build web (`ottm-web:<tag>`, cùng tag với api) do nginx trong container phục vụ: SPA fallback, `Cache-Control`. Không root, root FS chỉ đọc. Chỉ khi `COMPOSE_PROFILES=web` | `127.0.0.1:WEB_HOST_PORT` (chỉ máy chủ) |
| `migrate` | chạy migration DB một lần rồi thoát, trước api/worker | không |
| `api` | REST, SSE, webhook, OAuth | `127.0.0.1:API_HOST_PORT` (chỉ máy chủ) |
| `worker` | job nền, cron | không |
| `postgres` | Postgres 18, dữ liệu ở volume `pgdata` | không |

Dữ liệu: volume Docker `pgdata` (DB). Ảnh (bài đăng, logo) và file (kho kiến thức, đính kèm) nằm trên
**Cloudinary** (mục 1.5), không lưu trên máy chủ. Build web nằm trong image `ottm-web:<tag>` (không có thư mục web trên
máy chủ). Chứng chỉ TLS ở `/etc/letsencrypt` (certbot).

Mọi việc triển khai làm **bằng tay** với `docker compose` (không có script deploy). Service `web` thuộc profile `web`
của compose; `deploy/.env` đặt sẵn `COMPOSE_PROFILES=web`, nên mọi lệnh `docker compose …` gõ tay thấy service `web`
như mọi service khác:

- `docker compose up -d --build` build và chạy cả api, worker, migrate, postgres **và web**.
- `IMAGE_TAG` (trong `deploy/.env`, mặc định `latest`) là tag của cả hai image `ottm-server`, `ottm-web`.
  **Build lại cùng tag ghi đè image cũ** → không quay lại được bản trước. Muốn rollback được: mỗi lần lên bản mới đặt
  tag mới (mục 2), rollback = đổi `IMAGE_TAG` về tag cũ rồi `docker compose up -d` (không `--build`, mục 3).
- `ps`, `logs`, `restart`, `down` cũng tính cả web. Thiếu dòng `COMPOSE_PROFILES=web` (file `.env` cũ) thì các lệnh
  này bỏ qua web — thêm dòng đó, hoặc gõ `--profile web`.
- Web trên Hostinger (mục 8): để trống `COMPOSE_PROFILES` — VPS không build, không chạy web.

---

## 1. Cài lần đầu

### 1.1 Chuẩn bị

- VPS Ubuntu 24.04 (hoặc Debian 12+), tối thiểu 2 vCPU, 4 GB RAM, 40 GB SSD. RAM 2 GB thì thêm 2 GB swap (build web cần bộ nhớ).
- Một tên miền, ví dụ `app.example.com`.
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

Lưu ý: Docker tự mở firewall cho cổng mà container publish, bỏ qua ufw. Stack này chỉ publish cổng api và web trên
`127.0.0.1` (không ra được internet, chỉ nginx trên máy chủ gọi tới); Postgres (5432) không publish. Đừng thêm
`ports:` cho service khác, và đừng đổi `127.0.0.1:` của api/web thành cổng trần.

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
| `COMPOSE_PROFILES` | `web` (mặc định: web chạy trên VPS). Trống = web trên Hostinger (mục 8, kèm `WEB_BASE_URL`, `ALLOWED_ORIGINS`) |
| `IMAGE_TAG` | `latest` (mặc định); đặt tag mới mỗi lần lên bản để rollback được (mục 2–3) |
| `CLOUDINARY_URL` | `cloudinary://<api_key>:<api_secret>@<cloud_name>` (mục 1.5); trống → tính năng ảnh/file báo chưa cấu hình |
| `API_HOST_PORT` | mặc định `3000`; đổi nếu cổng này đã có dịch vụ khác trên máy (nhớ đổi cả `upstream ottm_api` trong nginx) |
| `WEB_HOST_PORT` | mặc định `3080` (container web, chỉ `127.0.0.1`); đổi nếu bận (nhớ đổi cả `upstream ottm_web` trong nginx); phải khác `API_HOST_PORT` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `META_APP_ID`, `META_APP_SECRET`, `META_APP_ENV` | để trống tới khi kết nối Facebook/Instagram; khi đặt thì cả ID lẫn secret, `META_APP_ENV=live` (app không khởi động với Meta Test App) |
| `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_APP_ENV` | đặt cả cặp hoặc để trống cả hai; khi đặt thì `THREADS_APP_ENV=live` |
| `APP_ENCRYPTION_KEYS` | **bắt buộc** — `echo "k1:$(openssl rand -base64 32)"` (dạng `<keyId>:<base64 32 byte>`, nhiều khoá phẩy ngăn cách) |
| `APP_ENCRYPTION_ACTIVE_KEY` | **bắt buộc** — keyId đang dùng để mã hoá, phải có trong `APP_ENCRYPTION_KEYS` (vd `k1`) |

Thiếu `APP_ENCRYPTION_KEYS`/`APP_ENCRYPTION_ACTIVE_KEY`, khoá không phải base64 của đúng 32 byte, hoặc
keyId active không có trong danh sách → api, worker, migrate **không khởi động** (exit ≠ 0, log nêu tên biến).
Xem bằng `docker compose logs api`.

**Xoay khoá chủ:** thêm khoá mới vào cuối `APP_ENCRYPTION_KEYS` (giữ khoá cũ), đổi
`APP_ENCRYPTION_ACTIVE_KEY` sang keyId mới, rồi `docker compose up -d` (trong `deploy/`). Bản ghi cũ vẫn giải mã bằng khoá cũ;
chỉ bỏ khoá cũ khỏi danh sách khi chắc không còn bản ghi nào dùng nó (nếu bỏ sớm: nhập lại khoá OpenAI ở
Cài đặt).

**Cất riêng, ngoài VPS** (trình quản lý mật khẩu) — mất VPS là mất chúng:

- `APP_ENCRYPTION_KEYS` và `APP_ENCRYPTION_ACTIVE_KEY` — mất thì khoá OpenAI và token Meta trong DB không giải mã được.
- `POSTGRES_PASSWORD`, các app secret của Meta/Threads, `CLOUDINARY_URL`.

Cách đơn giản: lưu cả nội dung `deploy/.env` thành một mục trong trình quản lý mật khẩu, cập nhật mỗi khi sửa.

### 1.5 Cloudinary (ảnh và file)

Ảnh bài đăng, logo (công khai) và file kho kiến thức, đính kèm của khách (riêng tư) lưu trên Cloudinary — không có
thư mục media nào trên máy chủ, nginx không phục vụ `/media`. Hệ thống không có backup tự động (sao lưu tay DB: mục 4).

1. Tạo tài khoản ở <https://cloudinary.com> (gói Free đủ để bắt đầu; giới hạn mỗi file 10 MB). Nên dùng **một tài
   khoản riêng cho production**, dev dùng tài khoản khác (hoặc ít nhất `CLOUDINARY_FOLDER` khác).
2. Console › **Settings › API Keys**: chép dòng *API environment variable* — dạng
   `cloudinary://<api_key>:<api_secret>@<cloud_name>` (chỉ phần sau `CLOUDINARY_URL=`). Dán vào `deploy/.env`:

   ```dotenv
   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
   # CLOUDINARY_FOLDER=ottm      # thư mục gốc trên Cloudinary (mặc định ottm)
   ```

   `api_secret` là bí mật như mật khẩu: không dán vào chat, không chụp màn hình; cất cùng `deploy/.env` (mục 1.4).
   Sai dạng → api/worker/migrate **không khởi động** (log nêu `CLOUDINARY_URL`, không in giá trị). Để trống → app vẫn
   chạy, chỉ tính năng ảnh/file báo "chưa cấu hình kho ảnh".
3. Sau khi deploy (mục 1.7), kiểm cấu hình bằng một vòng thật (upload ảnh công khai + file riêng tư, tải lại, xác nhận
   file riêng tư **không** tải được bằng URL thường, rồi xoá):

   ```bash
   cd ~/OnTheTopMoney/deploy
   docker compose exec api npm run media:check
   ```

   Kết quả phải kết thúc bằng `media:check: tất cả ok` và in URL ảnh công khai `https://res.cloudinary.com/…` (mở được
   trên trình duyệt). Dòng `LỖI` kèm gợi ý: `AUTH_FAILED` = sai `CLOUDINARY_URL`; `TẢI ĐƯỢC bằng URL thường` = file riêng
   tư bị lộ — kiểm Console › Settings › Security (không bật cho phép giao file "authenticated" không chữ ký).
   Khi dev: `npm run media:check -w server` (đọc `server/.env`).
4. **Sao lưu media:** hệ thống không sao lưu ảnh/file (file dump tay ở mục 4 chỉ có DB). Bật backup của Cloudinary: Console ›
   Settings › Upload (hoặc *Backup*) › bật **Automatic backup** (tuỳ gói; gói Free có thể không có — khi đó ảnh/file chỉ
   có một bản trên Cloudinary). Xoá tài khoản/thư mục trên Cloudinary là mất ảnh/file vĩnh viễn.
5. Cloudinary là bên xử lý dữ liệu của bạn: file kho kiến thức và đính kèm của khách nằm ở đó (dạng `authenticated`,
   chỉ server tải được). Khi tạo tài khoản, chọn vùng lưu dữ liệu (data region) nếu Cloudinary cho chọn. Đính kèm của
   khách và file kho kiến thức là **dữ liệu cá nhân chuyển ra dịch vụ nước ngoài** — cân nhắc nghĩa vụ theo Nghị định
   13/2023/NĐ-CP (bảo vệ dữ liệu cá nhân, chuyển dữ liệu ra nước ngoài) và ghi rõ vào chính sách quyền riêng tư.

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
# Nếu deploy/.env đổi API_HOST_PORT / WEB_HOST_PORT: sửa tương ứng
#   127.0.0.1:3000 (upstream ottm_api), 127.0.0.1:3080 (upstream ottm_web)
sudo ln -s ../sites-available/ottm /etc/nginx/sites-enabled/ottm
sudo nginx -t && sudo systemctl reload nginx
```

Những điểm **bắt buộc giữ** khi tự chỉnh (đầu file mẫu có danh sách đầy đủ; CI chạy `nginx -t` trên mẫu):

- Các đường `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` (kể cả không có `/…` phía sau) đi tới api;
  còn lại `proxy_pass` tới container web (`upstream ottm_web`), container lo SPA
  fallback, `/assets/` thiếu → 404 và `Cache-Control`.
- `Cache-Control`: nginx máy chủ chỉ thêm `no-store` cho lỗi mà upstream chưa đặt — không thêm cái thứ hai lên
  response của web/api (map `$ottm_cache_control`).
- `proxy_set_header X-Forwarded-For $remote_addr;` — **không** dùng `$proxy_add_x_forwarded_for` (client tự gửi
  `X-Forwarded-For` giả để né giới hạn đăng nhập). api tin đúng một hop (`TRUST_PROXY=true`).
- CSP `img-src` gồm `https://res.cloudinary.com` (ảnh bài đăng, logo — mục 1.5).
- Header bảo mật chỉ đặt ở cấp `server` với `always`. Một `add_header` trong `location` làm location đó mất **mọi**
  header của server (quy tắc kế thừa của nginx) — mẫu dùng `map` thay cho add_header trong location.
- `/api/v1/stream` (SSE): `proxy_buffering off`, `proxy_read_timeout` ≥ 1 giờ; không bật gzip trên đường api.
- Không access log cho `/oauth`, `/webhooks` (URL mang `code`, `hub.verify_token`).
- Sau mỗi deploy/rollback **không cần reload nginx**: container web luôn ở cùng cổng `127.0.0.1:WEB_HOST_PORT`. Chỉ
  reload khi sửa file cấu hình (`sudo nginx -t && sudo systemctl reload nginx`).

Thứ tự lần đầu: làm mục này **trước** khi deploy (mục 1.7 kiểm qua `PUBLIC_BASE_URL`, tức là qua nginx). Trước lần
deploy đầu, nginx trả 502 `web unavailable` cho web và 502 JSON cho api — bình thường.

### 1.7 Triển khai lần đầu

**Kiểm cổng bận** (lần đầu, và mỗi khi đổi `API_HOST_PORT`/`WEB_HOST_PORT`): cổng của api (mặc định 3000) và web
(3080) phải trống trên máy chủ, không thì `docker compose up` lỗi "port is already allocated":

```bash
sudo ss -ltnp '( sport = :3000 or sport = :3080 )'   # không in dòng nào = trống
```

Có tiến trình khác giữ → đổi `API_HOST_PORT`/`WEB_HOST_PORT` trong `deploy/.env` (hai số phải khác nhau) và sửa
`upstream` tương ứng trong site nginx (mục 1.6). Postgres không mở cổng ra máy chủ, nên 5432 bận không sao.

```bash
cd ~/OnTheTopMoney/deploy
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$(git rev-parse --short HEAD)/" .env    # tag = commit đang chạy (để rollback, mục 3)
docker compose up -d --build
docker compose ps                     # migrate: Exited (0); api, web: healthy; worker, postgres: running
```

`docker compose up` build hai image (`ottm-server`, `ottm-web`) theo `IMAGE_TAG`, chạy `migrate` một lần
rồi `api`, `worker`, `web`. Lần đầu mất vài phút (build). `migrate` lỗi → api/worker không chạy: xem
`docker compose logs migrate`.

Kiểm trên VPS (gọi thẳng, không qua nginx) rồi qua tên miền:

```bash
curl -s http://127.0.0.1:3000/healthz            # api: {"ok":true,"db":"ok","worker":"ok","disk":"ok"} (worker cần ~30 s)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/healthz   # web: 200
curl -s https://app.example.com/healthz          # qua nginx + TLS
curl -sI https://app.example.com/ | grep -i -e '^HTTP' -e content-security-policy -e strict-transport
```

Mở `https://app.example.com` trên trình duyệt: thấy màn đăng nhập, tải lại một đường sâu (vd `/trang-nhom`) vẫn ra
trang (SPA). Lỗi qua nginx mà `127.0.0.1` ổn → cấu hình nginx: `sudo nginx -t`, `sudo tail -n 50 /var/log/nginx/error.log`.

Rồi kiểm Cloudinary: `cd deploy && docker compose exec api npm run media:check` (mục 1.5 bước 3).

### 1.8 Đặt mật khẩu chủ sở hữu và đăng nhập

```bash
cd ~/OnTheTopMoney/deploy
docker compose run --rm api node scripts/set-password.ts
```

Nhập mật khẩu hai lần (ít nhất 12 ký tự). Đặt lại bất kỳ lúc nào bằng cùng lệnh; mọi phiên cũ bị đăng xuất.
Mở `https://app.example.com` → màn đăng nhập → nhập mật khẩu.

### 1.9 Uptime ping ngoài

Tạo một monitor HTTP ở dịch vụ bên ngoài (UptimeRobot, Better Stack, …):

- URL `https://app.example.com/healthz`, mỗi **5 phút**, báo khi mã khác 200.
- Ý nghĩa khi 503 (xem body JSON):
  - `"db":"down"` — Postgres lỗi: `docker compose ps postgres`, `docker compose logs --tail=100 postgres`.
  - `"worker":"stale"` — worker không ghi heartbeat quá 2 phút: `docker compose logs --tail=100 worker`, `docker compose restart worker`.
  - `"disk":"full"` — đĩa dùng >85%: xem mục 5.
  - `"disk":"unknown"` không gây 503 (không đo được đĩa), nhưng nên xem log api.

### 1.10 Máy đã chạy bản cũ (reverse proxy trong compose, media trong volume Docker)

Chỉ cần nếu VPS từng chạy bản stack có container reverse proxy riêng giữ cổng 80/443 và media trong volume `ottm_media`.
Làm một lần, trước mục 1.6:

```bash
cd ~/OnTheTopMoney/deploy
docker compose down                         # dừng stack cũ, GIỮ volume — giải phóng cổng 80/443 cho nginx
```

Rồi làm mục 1.5 (Cloudinary), 1.6 và 1.7. Ảnh cũ trong volume `ottm_media` **không** được chuyển tự
động lên Cloudinary (chưa có tính năng nào dùng media trước mốc này). Khi app chạy ổn: `docker volume rm ottm_media` và
xoá image cũ của proxy (`docker image ls`, `docker image rm <tên>:<tag>`).

### 1.11 Máy đã chạy bản web chép ra thư mục máy chủ (`/var/www/ottm/current`)

Chỉ cần nếu VPS từng chạy bản mà script deploy cũ chép build web ra `/var/www/ottm/<tag>` và nginx phục vụ
`root /var/www/ottm/current`. Nay web là service Docker `web`; làm một lần.

**Đọc trước bước 2:** sau lần lên bản đầu theo cách mới, **không** rollback được về bất kỳ tag nào trước đó (image
`ottm-web` cũ chỉ mang build web, không chạy được như service). Nếu phải lùi: checkout commit cũ, đổi lại site nginx
cũ (`root /var/www/ottm/current`, giữ thư mục `/var/www/ottm` tới khi chắc chắn); hoặc khôi phục file `pg_dump` tay (mục 4).
Ghi lại tag đang chạy (`grep '^IMAGE_TAG=' deploy/.env`) trước khi bắt đầu.

1. `git pull`. Thêm `WEB_HOST_PORT=3080` và `COMPOSE_PROFILES=web` vào `deploy/.env` (kiểm cổng bận như mục 1.7).
   Dòng đường dẫn thư mục web cũ (`/var/www/ottm`) và dòng chọn chế độ web cũ (giá trị `vps`) trong `deploy/.env` không còn dùng — xoá được.
2. Sao lưu tay (mục 4) rồi lên bản mới với tag mới (mục 2). Container web chạy ở `127.0.0.1:3080`, nhưng site nginx cũ **vẫn phục
   vụ web cũ** từ `/var/www/ottm/current` (web cũ chạy với api mới). **Làm bước 3 ngay.**
3. Sửa site nginx theo `deploy/nginx.conf.example` mới (hoặc chép lại từ mẫu như mục 1.6 và thay giá trị):
   - thêm khối `upstream ottm_web { server 127.0.0.1:3080; keepalive 8; }`;
   - thay map `$ottm_cache_control_want` bằng bản mới (chỉ `no-store` cho lỗi — container web tự đặt `Cache-Control`);
   - bỏ `location ^~ /assets/` và `location = /.ottm…` (đánh dấu thư mục cũ); thay `location /` (`root …/current`,
     `try_files`) bằng `location /` có `proxy_pass http://ottm_web;` và `location @ottm_web_unavailable` như mẫu.

   Rồi `sudo nginx -t && sudo systemctl reload nginx` và kiểm như mục 1.7. Kiểm lần nữa là web đã từ container:
   `diff <(curl -s http://127.0.0.1:3080/) <(curl -s https://app.example.com/) && echo khớp`.
4. Khi chạy ổn vài ngày: xoá tay thư mục cũ `sudo rm -rf /var/www/ottm`.
5. Chỉ rollback tới các tag lên **sau** bước 2 (xem cảnh báo đầu mục). Image cũ tự xoá bằng tay khi không cần
   (`docker image rm ottm-web:<tag-cũ>`).

### 1.12 Máy đã chạy bản lưu media trên máy chủ (`/var/lib/ottm/media`, `/media` qua nginx)

Chỉ cần nếu `deploy/.env` còn dòng đường dẫn thư mục media (`…=/var/lib/ottm/media`) hoặc site nginx còn khối
`location` phục vụ `/media/`. Nay ảnh/file lưu trên Cloudinary; làm một lần:

1. `git pull`. Trong `deploy/.env`: xoá dòng thư mục media (không còn dùng), thêm `CLOUDINARY_URL` (mục 1.5).
2. Lên bản mới (mục 2) — api/worker không còn mount thư mục media; `/healthz` đo đĩa ở `/` của container.
3. Sửa site nginx theo `deploy/nginx.conf.example` mới (hoặc `nginx-api.conf.example` ở chế độ tách):
   - bỏ khối `location` của `/media/` (dòng `alias /var/lib/ottm/media/;` và `disable_symlinks`);
   - bỏ map `$ottm_csp` (`$ottm_api_csp` ở chế độ tách) và đặt CSP thẳng ở `add_header Content-Security-Policy …` như
     mẫu — `img-src` có thêm `https://res.cloudinary.com`.

   Rồi `sudo nginx -t && sudo systemctl reload nginx`, kiểm như mục 1.7 và
   `docker compose exec api npm run media:check` (trong `deploy/`).
4. Thư mục media cũ (`/var/lib/ottm/media`) **không** tự bị xoá. Chưa có tính năng nào ghi vào đó trước mốc này;
   xem nó rỗng (`sudo ls -A /var/lib/ottm/media`) rồi tự xoá khi chắc chắn: `sudo rm -rf /var/lib/ottm/media`.
---

## 2. Triển khai bản mới

Làm theo thứ tự (trong `~/OnTheTopMoney/deploy`):

```bash
cd ~/OnTheTopMoney && git pull && cd deploy
grep '^IMAGE_TAG=' .env                     # 1. ghi lại tag đang chạy — để rollback (mục 3)
# 2. NÊN sao lưu tay trước — migration chỉ tiến (rất nên khi bản mới có migration): lệnh pg_dump ở mục 4.1
new=$(git rev-parse --short HEAD)           # 3. tag MỚI (git SHA ngắn, hoặc v1, v2, …) — KHÔNG dùng lại tag cũ
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$new/" .env
docker compose up -d --build                # 4. build + chạy: migrate → api, worker, web cùng sang tag mới
docker compose ps                           # 5. migrate Exited (0); api, web healthy
```

Rồi kiểm `/healthz` và mở web như mục 1.7 (`curl -s http://127.0.0.1:3000/healthz`, `curl -s https://app.example.com/healthz`,
mở `https://app.example.com` trên trình duyệt và đăng nhập).

- **Tag mới mỗi lần, ghi vào `.env`.** Build lại với `IMAGE_TAG` đang có ghi đè image của tag đó — mất đường quay về.
  Gõ `IMAGE_TAG=v3 docker compose up -d --build` (không sửa `.env`) cũng được, nhưng mọi lệnh compose sau đó không kèm
  biến (restart, `up -d`) lại dùng tag cũ trong `.env` → quay ngược bản. Luôn sửa dòng `IMAGE_TAG=` trong `.env`. Bản mới có
  migration (thư mục `server/drizzle/` đổi: `git diff --stat <commit-cũ> HEAD -- server/drizzle`) thì nên `pg_dump`
  tay ở bước 2 (mục 4.1) và chép file ra ngoài VPS trước — không có bản sao tự động nào để quay về.
- Build lỗi → `docker compose up` dừng trước khi thay container: stack đang chạy giữ nguyên bản cũ; đặt lại
  `IMAGE_TAG` cũ trong `.env` cho khớp.
- Migration chạy trước api/worker (`depends_on`); chỉ tiến, tương thích ngược một phiên bản. `migrate` lỗi →
  `docker compose up` báo lỗi và không đưa api/worker lên bản mới: xem `docker compose logs migrate`, rồi rollback
  (mục 3) hoặc khôi phục file dump tay (mục 4.2).
- Container web được thay trong khoảng một giây — trong lúc đó nginx trả `502 web unavailable` cho trang web (trình
  duyệt tải lại là xong); không cần reload nginx.
- `/healthz` 503: xem body (mục 1.9). `"disk":"full"` → xử lý ngay (mục 5).
- Đổi `API_HOST_PORT`/`WEB_HOST_PORT` → kiểm cổng bận trước (mục 1.7).
- Dọn image cũ thỉnh thoảng (giữ vài tag gần nhất để rollback): `docker image ls 'ottm-*'`, rồi
  `docker image rm ottm-server:<tag> ottm-web:<tag>` — đừng xoá tag đang chạy.

## 3. Rollback

```bash
cd ~/OnTheTopMoney/deploy
docker image ls ottm-server              # các tag còn giữ, mới nhất trước
docker image ls ottm-web                 # phải có cùng tag (web cùng tag với api)
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<tag-cũ>/" .env
docker compose up -d                     # KHÔNG --build: dùng lại image cũ
docker compose ps
```

Không build lại; api, worker và web cùng về `<tag-cũ>`. Kiểm như mục 1.7. Thiếu `ottm-server:<tag>` hoặc
`ottm-web:<tag>` (đã xoá, hoặc tag đã bị build đè) → compose sẽ build lại từ mã đang checkout, **không** phải bản cũ:
khi đó `git checkout <commit-cũ>` rồi `docker compose up -d --build` với tag đó. Image `ottm-web` của bản trước mục 1.11
(chỉ mang build web, không có nhãn `org.ottm.web=nginx` — xem `docker image inspect ottm-web:<tag> --format '{{json .Config.Labels}}'`)
không chạy được — không rollback qua mốc đó.
Migration chỉ tiến: image cũ chạy được trên schema mới hơn **một** phiên bản. Nếu cần lùi qua nhiều bản có đổi schema,
khôi phục file dump tay chụp trước bản đó (mục 4.2) thay vì rollback.

## 4. Sao lưu tay (tuỳ chọn)

**Hệ thống không có backup tự động.** Không có job, cron hay kho sao lưu nào: DB chỉ nằm trong volume `pgdata` trên
VPS. Muốn có bản sao thì tự chạy `pg_dump` dưới đây (vd trước mỗi lần lên bản có migration, và định kỳ theo ý bạn),
rồi **chép file ra ngoài VPS** — file chỉ nằm trên VPS thì mất cùng VPS. Ảnh/file nằm trên Cloudinary, không có trong
file dump (mục 1.5 bước 4).

### 4.1 Sao lưu DB ra file

```bash
cd ~/OnTheTopMoney/deploy
install -d -m 700 ~/ottm-dumps
docker compose exec -T postgres pg_dump -U ottm -d ottm -Fc > ~/ottm-dumps/ottm-$(date +%F-%H%M).dump
ls -lh ~/ottm-dumps                                     # file phải > 0 byte
# chép về máy khác (chạy ở máy đó):  scp deploy@<ip-vps>:ottm-dumps/ottm-<ngày>.dump .
```

File dump chứa toàn bộ dữ liệu khách (tin nhắn, SĐT…) — cất ở chỗ riêng tư như mật khẩu. Khoá OpenAI và token Meta
trong đó đã mã hoá bằng `APP_ENCRYPTION_KEYS`: khôi phục ở máy khác cần đúng khoá đó (mục 1.4).

### 4.2 Khôi phục DB từ file (ghi đè DB đang chạy)

```bash
cd ~/OnTheTopMoney/deploy
docker compose stop api worker
docker compose exec -T postgres psql -U ottm -d ottm -v ON_ERROR_STOP=1 \
  -c 'drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;'
docker compose exec -T postgres pg_restore -U ottm -d ottm --no-owner --no-privileges --single-transaction --exit-on-error \
  < ~/ottm-dumps/ottm-<ngày>.dump
docker compose up -d                                    # chạy lại migrate: đưa schema của file dump lên bản đang chạy
curl -s https://app.example.com/healthz
```

Lệnh `drop schema` xoá **toàn bộ** dữ liệu hiện có trước khi nạp file — chắc chắn đúng file trước khi chạy. Nạp lỗi
giữa chừng → DB trống (không phải dữ liệu cũ): chạy lại `pg_restore` với file khác. DB về thời điểm cũ có thể trỏ tới
ảnh/file đã bị xoá trên Cloudinary sau thời điểm đó.

**Sang VPS mới (máy cũ mất):** làm mục 1.1–1.7 trên VPS mới với **đúng** `deploy/.env` đã cất (cùng
`APP_ENCRYPTION_KEYS`, `CLOUDINARY_URL` — ảnh/file vẫn ở Cloudinary), đổi DNS sang IP mới (trước khi lấy chứng chỉ ở
1.6), chép file dump lên rồi làm 4.2. Bật lại uptime ping (1.9).

## 5. Vận hành hằng ngày

### Log

```bash
cd ~/OnTheTopMoney/deploy
docker compose --profile web ps
docker compose logs -f --tail=100 api worker
docker compose logs --tail=100 migrate postgres
docker compose --profile web logs --tail=100 web     # nginx trong container web (chỉ error log; access log ở nginx máy chủ)
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log      # nginx (theo cấu hình của bạn)
```

Log JSON (pino), xoay vòng tự động 10 MB × 5 file mỗi service. Log không chứa mật khẩu, token, cookie.
Log nginx do logrotate của gói nginx xoay. Mẫu nginx tắt access log cho `/oauth`, `/webhooks` (URL có thể mang mã bí
mật) và chỉ ghi lỗi mức `crit` ở đó; đừng bật lại.

### Khởi động lại / dừng

```bash
docker compose restart api worker
docker compose --profile web restart web         # khởi động lại web (COMPOSE_PROFILES=web)
docker compose --profile web down                # dừng tất cả (cả web), GIỮ dữ liệu — thiếu --profile web có thể sót container web
# KHÔNG chạy `docker compose down -v` trên production: -v xoá volume pgdata (toàn bộ DB).
# (ảnh/file nằm trên Cloudinary, không bị ảnh hưởng.)
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

Nếu vẫn đầy: xem kích thước volume (`docker system df -v`), image theo tag
(`docker image ls 'ottm-*'`, xoá tag cũ không cần — mục 2), nâng dung lượng đĩa VPS.

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
5. Webhooks (dùng từ Epic 4, Story 4.1): **Webhooks** → Page / Instagram → callback `https://<tunnel>/webhooks/meta`,
   verify token = giá trị `META_VERIFY_TOKEN` trong `server/.env` (`openssl rand -hex 16`). Bật field tối thiểu:
   Page `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`, `message_reads`, `feed`; Instagram
   `messages`, `messaging_seen`, `comments` (Story 4.5: echo nhận diện tin của chính trang, "đã nhận / đã xem"). Threads
   webhook: app Threads → **Webhooks** → callback `https://<tunnel>/webhooks/threads`, cùng verify token, field
   `replies`.
   - **Production** (app Live): cùng các bước trên nhưng callback dùng tên miền thật —
     `https://<tên miền>/webhooks/meta` và `https://<tên miền>/webhooks/threads` (= `PUBLIC_BASE_URL` +
     `/webhooks/{meta,threads}`); verify token = `META_VERIFY_TOKEN` trong `deploy/.env`. Chủ shop cũng xem được
     URL + verify token ở **Cài đặt › Webhook** (có nút sao chép). Đây là bước triển khai một lần (AD-4).
   - **Đăng ký theo trang là tự động (Story 4.2)**: bước cấp app ở trên chỉ làm **một lần** cho mỗi app. Mỗi khi chủ
     shop xác nhận hoặc kết nối lại trang, worker chạy job `connections.subscribe_page`: Fanpage gọi
     `POST /{page-id}/subscribed_apps` (`messages,messaging_postbacks,message_echoes,message_deliveries,message_reads,feed`);
     Instagram đăng ký qua Fanpage nguồn với cùng field — field IG `messages`, `messaging_seen`, `comments` **chỉ bật ở
     cấp app** (bước trên), app không bật qua API; Threads không có API đăng ký theo tài khoản — field `replies` **chỉ
     bật ở cấp app**. Worker khởi động sẽ chạy bù cho trang đã kết nối mà chưa từng đăng ký, hoặc đã đăng ký với danh
     sách field cũ (vd bản trước Story 4.5) — nhớ bật thêm field mới ở cấp app trước khi deploy. Trang đăng ký lỗi hiện ở **Cài đặt › Webhook** và trang
     chi tiết (thiếu quyền / token hỏng → kết nối lại trang).
   - **Sức khoẻ webhook**: cron `webhooks.health` (5 phút) đánh dấu `stalled` khi sản phẩm (Facebook/Instagram hoặc
     Threads) có trang đang hoạt động mà không nhận sự kiện nào quá 30 phút trong 08:00–22:00 giờ VN; Hộp thư hiện
     banner vàng "Chưa nhận tin mới 30 phút". Gặp banner: kiểm callback + verify token + field ở trên còn đúng, app
     còn Live, và log `docker compose logs api | grep webhook` có `401` (sai app secret) hay không.
   - **Chữ ký webhook Threads [ASSUMPTION]**: tài liệu Meta chưa nói rõ app secret nào ký `X-Hub-Signature-256`
     của webhook Threads. App hiện kiểm chữ ký `/webhooks/threads` bằng **Threads app secret** (`THREADS_APP_SECRET`).
     Khi có sự kiện Threads thật, xác nhận lại tại đây và ghi secret đúng: ______________________________________.

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
| Kiểm cổng bận | `sudo ss -ltnp '( sport = :3000 or sport = :3080 )'` (lần đầu / khi đổi cổng) |
| Lên bản mới | `git pull`, `pg_dump` tay (mục 4.1), đặt `IMAGE_TAG=<tag-mới>` trong `.env`, `docker compose up -d --build` (mục 2) |
| Rollback | đặt `IMAGE_TAG=<tag-cũ>` trong `.env`, `docker compose up -d` (không `--build`, mục 3) |
| Kiểm / nạp lại nginx | `sudo nginx -t && sudo systemctl reload nginx` (chỉ khi sửa cấu hình nginx) |
| Đặt mật khẩu | `docker compose run --rm api node scripts/set-password.ts` |
| Kiểm Cloudinary | `docker compose exec api npm run media:check` (mục 1.5) |
| Sao lưu tay DB | `docker compose exec -T postgres pg_dump -U ottm -d ottm -Fc > ~/ottm-dumps/ottm-$(date +%F-%H%M).dump` (mục 4.1) |
| Khôi phục DB | mục 4.2 (stop api worker → drop schema → `pg_restore` → `up -d`) |
| Kiểm nhanh | `curl -s https://app.example.com/healthz`, rồi mở web trên trình duyệt |
| Log | `docker compose logs -f --tail=100 api worker` (web: `docker compose --profile web logs web`) |
| Khởi động lại web (`COMPOSE_PROFILES=web`) | `docker compose --profile web up -d web` |
| Dừng cả stack | `docker compose --profile web down` (không `-v`) |
| Xuất bản web (chế độ tách) | `VITE_API_ORIGIN=https://api.example.com HOSTINGER_SSH=… HOSTINGER_PATH=… ./deploy/hostinger/publish-web-hostinger.sh` (ở gốc repo, mục 8.4) |
| Kiểm web (chế độ tách) | `./deploy/hostinger/check-htaccess.sh https://app.example.com https://api.example.com` (ở gốc repo) |
| Kiểm host api (chế độ tách) | `curl -s https://api.example.com/healthz` và các lệnh ở mục 8.5 |

## 8. Chế độ tách: web trên Hostinger

Chế độ thứ hai (`COMPOSE_PROFILES=` để trống): web tĩnh (`web/dist`) nằm trên hosting Hostinger (Apache/LiteSpeed, `.htaccess`),
VPS chỉ chạy BE (api, worker, migrate, Postgres) sau nginx cho một **host api** riêng.

```
Trình duyệt ──https──> app.example.com  (Hostinger: web/dist + .htaccess)
     │
     ├──https (fetch/SSE, credentials: include, CORS)──> api.example.com  (VPS: nginx → 127.0.0.1:3000 → api)
     └──https (ảnh)──> res.cloudinary.com
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
   COMPOSE_PROFILES=                            # để trống: không build, không chạy service web trên VPS
   PUBLIC_BASE_URL=https://api.example.com      # host api: OAuth callback, webhook
   WEB_BASE_URL=https://app.example.com         # host web: OAuth xong chuyển chủ shop về đây
   ALLOWED_ORIGINS=https://app.example.com      # origin web (phẩy ngăn cách nếu nhiều), phải gồm WEB_BASE_URL
   ```

   `WEB_HOST_PORT` không dùng. Tự kiểm (không script nào kiểm thay): `WEB_BASE_URL` là origin https (không path,
   không `/` cuối), khác `PUBLIC_BASE_URL` và nằm trong `ALLOWED_ORIGINS` — api từ chối khởi động nếu sai (xem
   `docker compose logs api`). Ngược lại, khi web chạy trên VPS (`COMPOSE_PROFILES=web`) thì bỏ `WEB_BASE_URL` (hoặc đặt
   bằng `PUBLIC_BASE_URL`), không OAuth sẽ chuyển về sai host.
3. Cloudinary: như mục 1.5 (`CLOUDINARY_URL` trong `deploy/.env`); web trên Hostinger nhúng ảnh thẳng từ
   `https://res.cloudinary.com` (CSP của `.htaccess` đã cho phép).
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
   | `https://app.example.com` (`map $ottm_api_cors_allowed`) | origin web `WEB_BASE_URL` (mỗi origin web một dòng) |
   | `127.0.0.1:3000` (`upstream ottm_api_upstream`) | `127.0.0.1:<API_HOST_PORT>` |
   | `/var/www/letsencrypt` (khối cổng 80) | thư mục webroot certbot, chỉ khi dùng `certbot certonly --webroot` |

   ```bash
   cd ~/OnTheTopMoney
   sudo cp deploy/nginx-api.conf.example /etc/nginx/sites-available/ottm-api
   sudo sed -i 's/api\.example\.com/<host-api-của-bạn>/g' /etc/nginx/sites-available/ottm-api
   sudo sed -i 's/app\.example\.com/<host-web-của-bạn>/g' /etc/nginx/sites-available/ottm-api
   # API_HOST_PORT khác mặc định → sửa tay 127.0.0.1:3000 trong file
   sudo ln -s ../sites-available/ottm-api /etc/nginx/sites-enabled/ottm-api
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Mẫu này: `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` → api (SSE `/api/v1/stream` không đệm);
   `/` và đường lạ → JSON 404 (host api không phục vụ trang web); CSP `default-src 'none'`;
   **không** ghi đè header `Access-Control-*` của api (api tự đặt — thêm `*` ở nginx sẽ làm hỏng đăng nhập); chỉ lỗi do
   nginx tự sinh (413 ảnh quá lớn, 502/503/504) được gắn `Access-Control-Allow-Origin` của đúng origin web để web đọc
   được lỗi thay vì "Không kết nối được máy chủ". Ảnh bài `POST /api/v1/media-assets` nhận tới 11 MB (như file kho
   kiến thức). Tên
   map/upstream có tiền tố `ottm_api_` nên cài song song được với site cùng VPS lúc chuyển chế độ.
5. Lên bản như mục 2 (`docker compose up -d --build`) — với `COMPOSE_PROFILES` trống compose không build/chạy service
   `web`, chỉ BE. Container web còn lại từ chế độ VPS **không** tự mất: dừng + xoá bằng tay
   `docker compose --profile web rm -sf web`. Rồi kiểm host api bằng các lệnh ở mục 8.5. Rollback (mục 3) cũng chỉ
   quay BE (không cần `ottm-web:<tag>`).
6. App Meta/Threads production: Redirect URI là `https://api.example.com/oauth/facebook/callback` và
   `https://api.example.com/oauth/threads/callback`, webhook `https://api.example.com/webhooks/meta` (mục 6.1, 6.3 —
   trên app **production**).
7. Uptime ping (mục 1.9): `https://api.example.com/healthz` và thêm một monitor cho `https://app.example.com/`.

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
curl -s https://api.example.com/healthz                                   # {"ok":true,…}
curl -s https://api.example.com/                                          # JSON 404 NOT_FOUND (host api không phục vụ trang)
curl -si -X OPTIONS https://api.example.com/api/v1/auth/login \
  -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: POST' | grep -i -e '^HTTP' -e access-control-allow-origin
# mong: 204 và Access-Control-Allow-Origin: https://app.example.com
```

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Deep link (`/trang-nhom`) trả 404 của Hostinger | `.htaccess` chưa lên (file ẩn — bật "Show hidden files") hoặc nằm sai thư mục |
| Thiếu header bảo mật / `Cache-Control` | hosting tắt `mod_headers` (hiếm) — hỏi hỗ trợ Hostinger |
| "Không kết nối được máy chủ" ở màn đăng nhập | DevTools › Console: lỗi CORS → `ALLOWED_ORIGINS` thiếu/sai origin web (đúng `https`, đúng `www`, không `/` cuối); lỗi CSP `connect-src` → web build với `VITE_API_ORIGIN` khác host api |
| Đăng nhập xong vẫn bị đá về màn đăng nhập | cookie `ottm_sid` không đi kèm: web và api khác tên miền gốc (8.1), hoặc trình duyệt chặn cookie; xem `Set-Cookie` của `POST /api/v1/auth/login` ở tab Network |
| Kết nối Meta xong về sai trang | `WEB_BASE_URL` sai — sửa `deploy/.env`, `docker compose up -d` |
| "Đang kết nối lại…" mãi | SSE `https://api.example.com/api/v1/stream` bị chặn: tab Network (CORS? 401?), cấu hình SSE của nginx-api |

### 8.6 Chuyển từ chế độ cùng VPS sang tách

1. Cài site api song song site cũ (8.2 bước 1, 4); thêm tên web vào Hostinger và bật SSL ở đó (8.3).
2. Sửa `deploy/.env` (8.2 bước 2), lên bản và dọn container web (8.2 bước 5); đổi callback/webhook ở app Meta/Threads
   production (8.2 bước 6). Từ đây OAuth đi qua host api.
3. Xuất bản web lên Hostinger (8.4) **không** đặt `WEB_BASE_URL` cho script (chưa kiểm được vì tên web còn trỏ VPS).
   Muốn xem trước: kiểm bằng tên tạm/xem trước Hostinger cấp trong hPanel —
   `./deploy/hostinger/check-htaccess.sh https://<tên-tạm> https://api.example.com` (đăng nhập qua tên tạm thì không
   chạy: tên tạm không cùng tên miền gốc và không nằm trong `ALLOWED_ORIGINS`).
4. Trỏ DNS của tên web sang Hostinger, chờ DNS lan và SSL của Hostinger cấp xong (`curl -sI https://app.example.com`
   ra chứng chỉ hợp lệ). **Chỉ sau đó** kiểm 8.5 trên tên thật.
5. Lúc chuyển, **mọi người bị đăng xuất một lần**: cookie `ottm_sid` cũ do host web cũ (cùng VPS) đặt, chỉ gửi tới
   host đó; host api mới không nhận được nó → đăng nhập lại ở `https://app.example.com`.
6. Khi ổn: gỡ site `nginx.conf.example` cũ và image `ottm-web` cũ (`docker image rm $(docker image ls ottm-web -q)`;
   container web đã dừng + xoá ở bước 2).

Quay lại chế độ VPS: `COMPOSE_PROFILES=web`, bỏ `WEB_BASE_URL` / `ALLOWED_ORIGINS` (hoặc đặt = `PUBLIC_BASE_URL` của
tên miền chung — `WEB_BASE_URL` khác `PUBLIC_BASE_URL` làm OAuth chuyển về sai host), cài lại site `nginx.conf.example`,
lên bản như mục 2 với tag mới (build lại `ottm-web` và chạy container web).
