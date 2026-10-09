# Personal subscription execution

Fava currently runs Codex and Claude Code in a Cloudflare Sandbox through AI Gateway. This uses Fava's configured provider billing; selecting a model does **not** connect a user's ChatGPT or Claude subscription.

## Execution boundary

[T3 Code](https://github.com/pingdotgg/t3code) controls provider CLIs on a user's own or self-hosted machine. Its hosted interface and relay do not move the provider login to the hosted control plane. Fava should use the same boundary for a personal subscription option:

1. A project owner pairs a local Fava companion with one Fava account and explicitly selects which projects it may run. Codex CLI or Claude Code is installed and authenticated on that machine. Fava stores only a revocable device identity and capability, never the provider's access or refresh token.
2. The existing signed GitHub webhook remains the only way to queue work. A companion may claim a run only after Fava verifies the tracked spec, merge commit, project membership, selected model, and device grant. A lease and heartbeat prevent two companions from executing the same run.
3. The companion checks out the pinned merge commit, loads pinned skills and approved MCP grants, and runs the local CLI in an isolated workspace. It streams bounded logs and a staged diff to Fava. Cancellation revokes the run capability and stops the local process.
4. Fava performs the same spec conformance review and uses its repository-scoped GitHub App installation token to publish a draft implementation PR. A companion never receives a broad GitHub App private key or publishes directly. Cloudflare remains the source of run status, logs, artifacts, and Preview links.

This is a separate execution mode; the current Cloudflare Sandbox and AI Gateway path remains available when no companion is online. A queued run must retain its chosen mode so a subscription run cannot silently switch to Fava-billed inference.

## Provider constraints

- **Codex:** [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) supports open-source and locally hosted clients. [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) can use a user-authorized token on the host. OpenAI directs paid or remotely hosted apps to request separate access; Fava's shared cloud runner must not assume the open-source local flow is approved for it.
- **Claude Code:** [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) supports Claude Pro/Max login on the machine running the CLI. The companion uses that machine's existing login. Fava does not ask users to paste CLI credential files or subscription tokens into the web app.

## Required implementation before showing a Connect subscription control

- The project-scoped device API now pairs a device, returns its credential once, and supports listing, rotation, revocation, and an audit trail. Only its SHA-256 hash is stored. The local companion and run authorization are still needed before this is a usable connection.
- The server now pins cloud or local execution mode when the spec merges, fences competing local claims with a 90-second lease, and refuses claims after device revocation or loss of Fava admin membership. The local companion must still renew its lease and stop its process on cancellation or lease loss.
- A bounded artifact upload protocol that verifies the pinned commit and reviewed diff before publication.
- End-to-end tests for two competing companions, revoked devices, expired leases, and a spec that has not merged.

Until those paths are implemented and tested, the workspace should continue to label model runs as Fava-billed AI Gateway runs.
