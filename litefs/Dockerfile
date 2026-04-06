FROM diegosouzapw/omniroute:latest

USER root

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    fuse3 \
    sqlite3 \
    tini \
    && rm -rf /var/lib/apt/lists/*

ARG LITEFS_VERSION=0.5.13
RUN curl -L "https://github.com/superfly/litefs/releases/download/v${LITEFS_VERSION}/litefs-${LITEFS_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C /usr/local/bin litefs

RUN chmod 755 /usr/local/bin/litefs

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
