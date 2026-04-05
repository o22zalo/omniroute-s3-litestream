FROM alpine:3.19

# nodejs   — elector daemon (JavaScript)
# docker-cli — container control qua socket
RUN apk add --no-cache nodejs docker-cli

COPY elector.js /elector.js
RUN chmod +x /elector.js

ENTRYPOINT ["/elector.js"]
