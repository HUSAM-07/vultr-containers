# Fava technical design

The editable diagram is [fava-platform.drawio](fava-platform.drawio). Open it in diagrams.net. A Draw.io MCP tool is not available in this workspace, so the diagram is stored in Draw.io's native XML format.

## Product contract

1. A person signs in with a GitHub App user authorization. Fava lists only repositories available to both that user and the App installation.
2. Selecting a repository imports its file map and a small set of project instructions. GitHub remains the source of truth for code and specifications.
3. A person writes `specs/<slug>-<id>.md` with an outcome, scope, and acceptance criteria. Fava creates a `spec/<slug>-<id>` branch and a spec-only pull request.
4. No coding agent may run for that change until the spec PR is merged into the repository's default branch. A GitHub webhook, verified with the App webhook secret, records the merged spec commit and schedules implementation.
5. An isolated agent workspace checks out that exact commit. The agent receives the spec, selected project/shared skills, bounded repository context, chosen model, and approved MCP connections. It opens an implementation PR with test evidence and a preview URL.
6. A spec conformance check compares changed files and behavior against acceptance criteria. Unrelated changes are flagged or removed before the implementation PR is marked ready.

The current implementation covers steps 1–3 locally once a GitHub App is configured, including personal account creation, repository project links, and spec PR records in D1. The editor saves a selected model on the spec record. A signed `pull_request.closed` webhook verifies the App installation, PR files, and spec content at the merge commit before marking a tracked spec merged and creating one queued run. The separate `runner/` Worker polls D1, starts a Cloudflare Sandbox container, checks out the pinned merge commit, and runs Codex or Claude Code through AI Gateway. It saves bounded logs and a diff in R2, then publishes changed regular files to a draft implementation PR through a repository-scoped GitHub App installation token. The workspace lets a linked project connect a Cloudflare account with an encrypted user API token and enable Worker Previews on an existing Git-connected Worker after validating separate Preview storage bindings. It has not been deployed or exercised against a live GitHub App, Cloudflare Worker Builds connection, container, or model. Automated semantic spec conformance and live Preview deployment remain unverified. The web app builds and serves locally as a Cloudflare Worker with vinext. The existing Forge demo is available at `/demo`; it is not connected to the merged-spec gate.

## Boundaries and Cloudflare services

| Boundary | Service | Why |
| --- | --- | --- |
| Web UI and authenticated API | Workers with vinext | Run the Next.js UI and route handlers close to users. Keep the current Next.js build path until vinext compatibility is verified. |
| Accounts, organizations, project links, spec/run state, audit records | D1 | Transactional relational state and tenant-scoped queries. GitHub still owns spec and code contents. |
| Session/authorization caches | Workers KV | Short-lived, revocable cache only; never the authority for roles or repo access. |
| Context snapshots, logs, screenshots, build artifacts | R2 | Bounded artifacts keyed by tenant/project/run; private by default. |
| Webhook ingestion and agent dispatch | Queues | Durable, at-least-once handoff after the webhook response. Deduplicate by delivery ID and merged commit in D1. |
| Long-running spec-to-PR lifecycle | Workflows | Persist retries, approval waits, and checkpoints. |
| Workspace and code execution | Sandboxes on Containers/Durable Objects | Isolate each run; mount only that project's credentials and bounded context. Expose authenticated preview URLs through the Sandbox preview capability. |
| User app deployment | Workers for Platforms | Cloudflare-native preview and production deployment of generated Workers; separate dispatch namespace and quotas per project. |
| Model routing | AI Gateway | Cost, policy, observability, and provider selection; user-owned API credentials remain encrypted and scoped. |
| Browser verification | Browser Run | Capture screenshots and verify interactive acceptance criteria when a spec needs browser evidence. |
| Abuse and observability | Turnstile, Workers Observability | Protect public registration endpoints and diagnose failures. |

Cloudflare service choice follows the workload: KV is a cache, D1 is the durable relational store, and R2 holds large blobs. Deploying every Cloudflare product would add cost and failure paths without satisfying a user requirement. AWS and GCP are optional deployment adapters, not dependencies of the Cloudflare-native path. Their connectors need scoped roles/service accounts and per-project consent; MCP servers run inside the project workspace, never in the browser.

The D1 migrations are [`0001_core.sql`](../infra/cloudflare/0001_core.sql), [`0002_spec_model.sql`](../infra/cloudflare/0002_spec_model.sql), [`0003_run_output.sql`](../infra/cloudflare/0003_run_output.sql), and [`0004_run_started_at.sql`](../infra/cloudflare/0004_run_started_at.sql). CI checks their relational constraints with SQLite. Both Workers must bind the same D1 database. The web Worker creates a personal account at GitHub sign-in and stores selected repository projects; the runner claims merged-spec runs. Account roles beyond personal ownership and revocation remain unimplemented at runtime. The local schema is applied with `npm run db:migrate:local` from `web/`; no remote database has been provisioned.

## Identity and GitHub integration

- GitHub App permissions: **Metadata: read**, **Contents: read/write**, **Pull requests: read/write**. Subscribe to `pull_request` events for the current webhook; installation and authorization revocation handlers are still required.
- OAuth uses state and PKCE. The current session is an AES-GCM encrypted, HTTP-only, SameSite=Lax cookie with token refresh. A production multi-tenant service will store sessions and encrypted provider credentials server-side in D1/R2 with a dedicated key-management policy; the cookie will then contain an opaque session ID.
- Fava account identity is the immutable GitHub user ID. Organization and project roles will be owner, admin, editor, viewer. Every API call must enforce Fava role **and** current GitHub installation/repository permission. Installation changes and revoked authorizations invalidate access.
- GitHub API writes use the person's GitHub App user token, so the audit trail attributes the action to that person. Webhook-triggered work uses an installation token restricted to the single repository.
- A spec PR contains only `specs/<slug>-<id>.md`. Branch protection and CI should require human approval before merge. The webhook checks the exact file and merged contents, records the merge commit, and creates an idempotent queued run with the selected model. After execution, the runner publishes a draft implementation PR from a branch tied to the run ID. The PR remains draft because semantic spec conformance is not yet checked automatically.

## Agent harness and source-of-truth checks

T3 Code's architecture informs the ownership boundary: the execution environment owns Git, files, provider processes, and credentials; web clients control it over authenticated APIs. Its provider adapters, durable command/effect separation, PR links, and project-level settings are useful patterns. Fava adds a spec gate that T3 Code does not enforce. See [T3 Code architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) and [source control guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md). T3 Code is MIT licensed; no source files have been copied into this repository.

The intended full harness input is an immutable tuple: `{repository, mergedSpecCommit, specPath, model, skillVersions, mcpGrantIds, deploymentTarget}`. The current runner pins the first four fields and saves bounded agent stdout, stderr, and the resulting diff under a run ID. A future run log must capture tool calls, test evidence, and previews before Fava can claim full inspection. Model adapters translate the task into Codex or Claude Code commands through AI Gateway. Fava does not assume a consumer Codex or Claude subscription can be transplanted into a shared cloud container; provider-supported authentication and explicit user consent determine each connection method.

Project skills live in `.fava/skills/*.md` in the target repository. Shared skills live in a dedicated versioned Fava skills repository. The run pins a commit for each skill, so later edits cannot silently change an in-flight build. Repository instructions such as `AGENTS.md` are imported as context, not executed as commands by the web service.

## Delivery sequence

1. Register the GitHub App and configure its callback, client secret, installation URL, and the Fava session secret. Verify a real sign-in, repository import, and spec PR.
2. Add D1 identity/project tables and a signed GitHub webhook endpoint. Make spec merge the only trigger for agent runs.
3. Deploy the vinext web Worker and separate Sandbox runner with the same D1 database, private R2 bucket, AI Gateway, and GitHub App credentials. Verify a real merge launches an isolated run. KV and Queues are still planned for cache and durable dispatch after account resources exist.
4. Add selected versioned skills, comprehensive run logs, semantic spec conformance checks, and preview URLs to the Sandbox runner; verify draft implementation PR publication against a live GitHub App.
5. Add Cloudflare Workers for Platforms deployment, then AWS/GCP deployment adapters and project-scoped MCP grants.

## Current external blockers

The GitHub account has no registered GitHub Apps, and developer settings require account verification before registration. Cloudflare's GitHub sign-in returned an error; the dashboard is at its sign-in page. No Cloudflare management credentials or CLI login are available in this environment, and no live Cloudflare resource has been provisioned. The code and diagram are prepared without claiming those external connections work.
