# Container image for Cloudflare Sandbox SDK runtime.
#
# Provides a sandboxed dev environment with:
# - Node 22 + git + curl + gh CLI
# - OpenCode agent (installed globally)
# - Bridge process for outbound WebSocket to control plane
# - Supervisor for process lifecycle management

FROM node:22-bookworm-slim AS base

# Install system dependencies (versions pinned to Bookworm stable)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git=1:2.39.* \
    curl=7.88.* \
    ca-certificates=20230311 \
    jq=1.6-* \
    openssh-client=1:9.2* \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium and dependencies for headless browser
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium=131.* \
    libnss3=2:3.87.* \
    libatk-bridge2.0-0=2.46.* \
    libxkbcommon0=1.5.* \
    libgbm1=23.2.* \
    fonts-liberation=1:2.* \
    fonts-noto-color-emoji=2.* \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install OpenCode agent and browser automation globally (pinned versions)
RUN npm install -g opencode-ai@1.2.24 agent-browser@0.17.1

# Create non-root user
RUN useradd -m -s /bin/bash -d /home/user user

# Copy bridge and supervisor
COPY bridge/ /opt/bridge/
COPY supervisor.sh /opt/supervisor.sh
RUN chmod +x /opt/supervisor.sh

# Copy git credential helper and gh CLI wrapper
COPY git-credential-helper.sh /app/sandbox/git-credential-helper.sh
COPY gh-wrapper.sh /app/sandbox/gh-wrapper.sh
RUN chmod +x /app/sandbox/git-credential-helper.sh /app/sandbox/gh-wrapper.sh

# Install bridge dependencies
WORKDIR /opt/bridge
RUN npm install --production

# Set up workspace
RUN mkdir -p /home/user/repo && chown -R user:user /home/user
WORKDIR /home/user/repo

USER user

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Supervisor manages OpenCode + bridge processes
ENTRYPOINT ["/opt/supervisor.sh"]
