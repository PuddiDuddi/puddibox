# Claude Code sandbox image: Debian + git + uv (with preinstalled Pythons) + Claude Code (native).
# Build: wslc build -t claude-sandbox:local agent
#
# Claude Code is installed at build time and auto-update is disabled at runtime
# (the container filesystem is discarded after every session). To update Claude Code,
# rebuild the image: .\Build-ClaudeSandbox.ps1
#
# Pin the images to digests for reproducible builds, for example
#   ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.0@sha256:<digest>
ARG BASE_IMAGE=debian:bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv
FROM ${BASE_IMAGE}

ARG PYTHON_VERSIONS="3.12 3.13"
# Gets the plain "python" and "python3" commands; must be one of PYTHON_VERSIONS.
ARG DEFAULT_PYTHON="3.12"
# Empty = the installer's default channel; or "stable", "latest", or a version such as "2.1.0".
ARG CLAUDE_CODE_VERSION=""
ENV DEBIAN_FRONTEND=noninteractive

# util-linux provides setpriv (privilege drop), tini is PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep tini bash less procps jq util-linux openssh-client \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

RUN useradd -m -u 1000 -s /bin/bash claude

# Python interpreters are downloaded now, at build time, because GitHub (where uv downloads
# Python from) is not on the runtime allowlist. Add versions via --build-arg PYTHON_VERSIONS.
# UV_PYTHON_BIN_DIR puts python3.12, python3.13, ... (and python/python3 for DEFAULT_PYTHON)
# on PATH for every user, so plain "python3 script.py" works too.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_BIN_DIR=/usr/local/bin
RUN uv python install ${PYTHON_VERSIONS} \
 && uv python install --default ${DEFAULT_PYTHON} \
 && chmod -R a+rX /opt/uv-python

# Claude Code, native installer, as the unprivileged user.
RUN su claude -s /bin/bash -c "curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION}"

# Runtime environment.
# PYTHONDONTWRITEBYTECODE: no .pyc files in the shared project folder. Windows Python would
# load a .pyc whose header matches the source, so any .pyc after a session is suspicious.
ENV HOME=/home/claude \
    PATH=/home/claude/.local/bin:${PATH} \
    CLAUDE_CONFIG_DIR=/home/claude/.claude \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/home/claude/.cache/uv

# The workspace bind mount shows every file as root:root, so git would refuse the repo
# ("dubious ownership") without this.
RUN git config --system --add safe.directory /workspace

RUN mkdir -p /workspace /home/claude/.claude /home/claude/.cache/uv \
 && chown -R claude:claude /home/claude

COPY entrypoint.sh check-egress.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/check-egress.sh \
 && chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/check-egress.sh

# Build gates: fail the build early if something essential is missing.
RUN set -eu; \
    for c in setpriv tini git curl rg uv timeout getent; do \
      command -v "$c" >/dev/null || { echo "missing tool: $c" >&2; exit 1; }; \
    done; \
    su claude -s /bin/bash -c 'export PATH=/home/claude/.local/bin:$PATH; claude --version'; \
    su claude -s /bin/bash -c 'python3 --version && python --version'; \
    su claude -s /bin/bash -c 'uv python list --only-installed'; \
    chown -R claude:claude /home/claude

WORKDIR /workspace
# Starts as root only to verify the sandbox and fix volume ownership, then drops to "claude".
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
