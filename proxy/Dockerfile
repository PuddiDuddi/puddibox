# Egress proxy sidecar (squid). Runs unprivileged; port 3128 needs no capabilities.
# Build: wslc build -t claude-egress-proxy:local proxy
#
# Pin the base image to a digest for reproducible builds, for example
#   ARG BASE_IMAGE=alpine:3.22@sha256:<digest>
ARG BASE_IMAGE=alpine:3.22
FROM ${BASE_IMAGE}

RUN apk add --no-cache squid tini \
 && mkdir -p /run/squid \
 && chown -R squid:squid /run/squid /var/cache/squid /var/log/squid

COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/proxy-entrypoint.sh
# Strip Windows line endings in case the files were edited on Windows.
RUN sed -i 's/\r$//' /etc/squid/squid.conf /usr/local/bin/proxy-entrypoint.sh \
 && chmod 0644 /etc/squid/squid.conf \
 && chmod 0755 /usr/local/bin/proxy-entrypoint.sh

USER squid
EXPOSE 3128
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/proxy-entrypoint.sh"]
