FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts @openai/codex@0.156.1 \
    && npm install --global @anthropic-ai/claude-code@2.1.280

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
