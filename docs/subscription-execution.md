# Personal subscription execution

Fava currently runs Codex and Claude Code in a Cloudflare Sandbox through AI Gateway. This uses Fava's configured provider billing; selecting a model does **not** connect a user's ChatGPT or Claude subscription.

## Execution boundary

[T3 Code](https://github.com/pingdotgg/t3code) controls provider CLIs on a user's own or self-hosted machine. Its hosted interface and relay do not move the provider login to the hosted control plane. Fava should use the same boundary for a personal subscription option:

1. A project owner pairs a local Fava companion with one project. Codex CLI or Claude Code is installed and authenticated on that machine. Fava stores only a revocable device identity and capability, never the provider's access or refresh token.
2. The existing signed GitHub webhook remains the only way to queue work. A companion may claim a run only after Fava verifies the tracked spec, merge commit, project membership, selected model, and device grant. A lease and heartbeat prevent two companions from executing the same run.
3. The companion checks out the pinned merge commit, retrieves selected skills at their pinned commits, and runs the local CLI in a temporary workspace. A heartbeat maintains its lease; cancellation or lease loss stops the child process. It submits bounded logs and a staged diff to Fava. Selected MCP grants use a short-lived capability tied to that run and device lease. The web Worker checks each pinned grant, revocation state, and tool name before forwarding a request, and keeps the upstream credential on the server.
4. Fava performs the same spec conformance review and uses its repository-scoped GitHub App installation token to publish a draft implementation PR. A companion never receives a broad GitHub App private key or publishes directly. Cloudflare remains the source of run status, logs, artifacts, and Preview links.

This is a separate execution mode; the current Cloudflare Sandbox and AI Gateway path remains available when no companion is online. A queued run must retain its chosen mode so a subscription run cannot silently switch to Fava-billed inference.

## Provider constraints

- **Codex:** [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) supports open-source and locally hosted clients. [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) can use a user-authorized token on the host. OpenAI directs paid or remotely hosted apps to request separate access; Fava's shared cloud runner must not assume the open-source local flow is approved for it.
- **Claude Code:** [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) supports Claude Pro/Max login on the machine running the CLI. The companion uses that machine's existing login. Fava does not ask users to paste CLI credential files or subscription tokens into the web app.

## Run the companion

Install Node.js, Git, and the provider CLI on a machine you control. Sign in through `codex login` or `claude` there. Pair that machine in the Fava project's device settings and copy the one-time device token. From this repository's root, run:

```sh
FAVA_URL=https://fava-platform.morrow-invitations.workers.dev \
FAVA_DEVICE_TOKEN="paste-one-time-device-token" npm run companion
```

Use `npm run companion -- --once` to claim at most one queued run. Keep the token in a local secret manager or a private shell session; the companion never writes it to the checkout or sends it to the agent subprocess. It needs your local Git credentials to fetch the project repository. Revoke its project device in Fava to stop future claims; the next heartbeat stops an active child process. The temporary checkout is removed after completion.

The companion only accepts the two currently pinned model choices. The installed CLI and your plan must support the selected model. Codex uses a workspace-write sandbox with automatic review and ignores unrelated user configuration for this run; Claude uses `acceptEdits` with only the run-selected MCP configuration, and may request permission for shell commands. Run-scoped MCP tokens are available to the local CLI process, so run the companion only with grants you intend that agent to use. Do not run this companion on a host containing credentials or files you would not let that locally signed-in CLI access.

## Current connection state

- The project-scoped device API pairs a device, returns its credential once, and supports listing, rotation, revocation, and an audit trail. Only its SHA-256 hash is stored. The companion claims project runs through this API.
- The workspace now offers a cloud or local execution choice for each spec. Project admins can pair, rotate, and revoke local devices. The server rejects a local spec before creating its GitHub PR if no eligible device is paired. A leased device fetches only the selected skills and MCP grants pinned to its run; skill source repositories are read with repository-scoped GitHub App tokens. MCP capabilities stop working when the lease expires, the device or grant is revoked, or the run is submitted or cancelled.
- The server pins cloud or local execution mode when the spec merges, fences competing local claims with a 90-second lease, and refuses claims after device revocation or loss of Fava admin membership. The companion renews the lease and stops its process on cancellation or lease loss.
- A device can submit a bounded staged diff, summary, and logs to private R2 under an active lease. The runner now replays the diff against the pinned merge commit inside a Sandbox, compares the resulting staged diff byte for byte, then uses the existing conformance review and draft PR publication path. This has unit coverage but cannot run live until the paid Containers runner and AI Gateway credential are available.
- End-to-end tests with a signed-in provider CLI and a real GitHub installation, including actual PR publication.

Until the local path is verified end to end, the workspace labels cloud runs as Fava-billed AI Gateway runs and local runs as subscription execution on the paired computer. Local runs use the user's CLI subscription for implementation, but Fava's server-side conformance review still uses its configured model billing.
