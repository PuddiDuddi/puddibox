# Credential-injecting proxy for the Claude API. Holds the subscription token; the agent
# gets only a placeholder. Runs unprivileged; port 8080 needs no capabilities.
# Build: wslc build -t claude-api-proxy:local api-proxy
#
# Pin the base image to a digest for reproducible builds, for example
#   ARG BASE_IMAGE=alpine:3.22@sha256:<digest>
ARG BASE_IMAGE=alpine:3.22
FROM ${BASE_IMAGE}

RUN apk add --no-cache python3 ca-certificates tini \
 && adduser -D -H -u 1000 apiproxy

COPY api_proxy.py /usr/local/bin/api_proxy.py
# Strip Windows line endings in case the file was edited on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/api_proxy.py \
 && chmod 0644 /usr/local/bin/api_proxy.py

USER apiproxy
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "python3", "-I", "/usr/local/bin/api_proxy.py"]
