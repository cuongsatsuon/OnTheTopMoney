# Image `ottm-backup`: pg_dump/pg_restore/psql cùng phiên bản Postgres 18 + restic (mã hoá, đẩy lên kho
# S3-compatible) + rsync (khôi phục media). Build context = deploy/ (xem Dockerfile.dockerignore).
FROM postgres:18

RUN apt-get update \
 && apt-get install -y --no-install-recommends restic rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && restic version

COPY backup/backup.sh backup/restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh

ENTRYPOINT ["backup.sh"]
CMD []
