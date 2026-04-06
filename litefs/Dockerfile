FROM diegosouzapw/omniroute:latest

USER root

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    fuse3 \
    sqlite3 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Nếu để rỗng thì lấy release mới nhất.
# Nếu set (ví dụ 0.5.13) thì lấy đúng tag v<version>.
ARG LITEFS_VERSION=
RUN set -eux; \
    if [ -n "${LITEFS_VERSION}" ]; then \
      RELEASE_API="https://api.github.com/repos/superfly/litefs/releases/tags/v${LITEFS_VERSION}"; \
    else \
      RELEASE_API="https://api.github.com/repos/superfly/litefs/releases/latest"; \
    fi; \
    ASSET_URL="$(curl -fsSL "${RELEASE_API}" | grep -o 'https://[^\"]*litefs[^\"]*linux-amd64\.tar\.gz' | head -n1)"; \
    test -n "${ASSET_URL}"; \
    curl -fsSL "${ASSET_URL}" -o /tmp/litefs.tar.gz; \
    tar -xzf /tmp/litefs.tar.gz -C /usr/local/bin litefs; \
    chmod 755 /usr/local/bin/litefs; \
    rm -f /tmp/litefs.tar.gz

WORKDIR /app

COPY litefs/litefs.yml /etc/litefs.yml
COPY litefs/entrypoint.sh /entrypoint.sh
COPY litefs/healthcheck.sh /healthcheck.sh

RUN chmod +x /entrypoint.sh /healthcheck.sh

ENV PORT=20129
ENV HOST=0.0.0.0
ENV HOSTNAME=0.0.0.0
ENV BIND=0.0.0.0

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
