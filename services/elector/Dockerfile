FROM alpine:3.19

# bash     — scripting
# curl     — RTDB REST API calls
# jq       — JSON parsing
# docker-cli — container control qua socket
RUN apk add --no-cache bash curl jq docker-cli

COPY elector.sh /elector.sh
RUN chmod +x /elector.sh

ENTRYPOINT ["/elector.sh"]
