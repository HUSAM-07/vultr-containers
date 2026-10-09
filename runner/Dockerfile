# Cloudflare Sandbox requires amd64; its sandbox-shim image is amd64-only.
FROM --platform=linux/amd64 node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts @openai/codex@0.156.1 \
    && npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.280 \
    && codex --version && claude --version

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
