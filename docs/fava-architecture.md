# Fava technical design

The editable diagram is [fava-platform.drawio](fava-platform.drawio). Open it in diagrams.net. A Draw.io MCP tool is not available in this workspace, so the diagram is stored in Draw.io's native XML format.

## Product contract

1. A person signs in with a GitHub App user authorization. Fava lists only repositories available to both that user and the App installation.
2. Selecting a repository imports its file map and a small set of project instructions. GitHub remains the source of truth for code and specifications.
3. A person writes `specs/<slug>-<id>.md` with an outcome, scope, and acceptance criteria. Fava creates a `spec/<slug>-<id>` branch and a spec-only pull request.
4. No coding agent may run for that change until the spec PR is merged into the repository's default branch. A GitHub webhook, verified with the App webhook secret, records the merged spec commit and schedules implementation.
5. An isolated agent workspace checks out that exact commit. The agent receives the spec, selected project/shared skills, bounded repository context, chosen model, and approved MCP connections. It opens an implementation PR with test evidence and a preview URL.
6. A spec conformance check compares changed files and behavior against acceptance criteria. Unrelated changes are flagged or removed before the implementation PR is marked ready.

The current implementation covers steps 1–3 locally once a GitHub App is configured, including personal account creation, repository project links, and spec PR records in D1. The editor saves a selected model on the spec record. A signed `pull_request.closed` webhook verifies the App installation, PR files, and spec content at the merge commit before marking a tracked spec merged and creating one queued run. The workspace can select project or personal-workspace skills from linked repositories, and each run snapshots their selected commit IDs. The separate `runner/` Worker polls D1, starts a Cloudflare Sandbox container, checks out the pinned merge commit, and runs Codex or Claude Code through AI Gateway with those pinned skills. It saves bounded logs and a diff in R2, then asks the selected model to review the diff against the merged spec. A failing or inconsistent review blocks publication; a passing review permits a draft implementation PR through a repository-scoped GitHub App installation token. This model review is fallible and its 200 KB diff limit currently rejects larger changes. The workspace lets a linked project connect a Cloudflare account with an encrypted user API token and enable Worker Previews on an existing Git-connected Worker after validating separate Preview storage bindings. It has not been deployed or exercised against a live GitHub App, Cloudflare Worker Builds connection, container, or model. Live semantic review and Preview deployment remain unverified. The web app builds and serves locally as a Cloudflare Worker with vinext. The existing Forge demo is available at `/demo`; it is not connected to the merged-spec gate.

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

Cloudflare service choice follows the workload: KV is a cache, D1 is the durable relational store, and R2 holds large blobs. Deploying every Cloudflare product would add cost and failure paths without satisfying a user requirement. AWS and GCP are optional deployment adapters, not dependencies of the Cloudflare-native path. Their connectors need scoped roles/service accounts and per-project consent; remote MCP servers are reached through the run's outbound Worker, never directly from the browser.

The D1 migrations are [`0001_core.sql`](../infra/cloudflare/0001_core.sql) through [`0008_run_mcp_grants.sql`](../infra/cloudflare/0008_run_mcp_grants.sql). CI checks their relational constraints with SQLite. Both Workers must bind the same D1 database. The web Worker creates a personal account at GitHub sign-in, allows team workspace creation and account role management, stores selected repository projects, and checks each session against a revocable D1 record; the runner claims merged-spec runs. Project admin, editor, and viewer roles are enforced at runtime together with current GitHub repository access. Workspace transfers remain unimplemented. A signed GitHub App authorization revocation webhook invalidates all active Fava sessions for that GitHub user. Admins can grant membership to a GitHub identity before that person signs in; Fava activates access when their verified GitHub ID signs in. The local schema is applied with `npm run db:migrate:local` from `web/`. The runner binds the remote `fava-core` D1 database ID, and the web Worker resolves it by name.

## Identity and GitHub integration

- GitHub App permissions: **Metadata: read**, **Contents: read/write**, **Pull requests: read/write**. Subscribe to `pull_request` and `github_app_authorization` events; installation change handlers are still required.
- OAuth uses state and PKCE. The current session is an AES-GCM encrypted, HTTP-only, SameSite=Lax cookie with token refresh. Its random ID is hashed in D1 and checked on every request; logout revokes it. A production multi-tenant service will move encrypted provider credentials server-side with a dedicated key-management policy, leaving only an opaque session ID in the cookie.
- Fava account identity is the immutable GitHub user ID. Organization and project roles will be owner, admin, editor, viewer. Every API call must enforce Fava role **and** current GitHub installation/repository permission. Installation changes and revoked authorizations invalidate access.
- GitHub API writes use the person's GitHub App user token, so the audit trail attributes the action to that person. Webhook-triggered work uses an installation token restricted to the single repository.
- A spec PR contains only `specs/<slug>-<id>.md`. Branch protection and CI should require human approval before merge. The webhook checks the exact file and merged contents, records the merge commit, and creates an idempotent queued run with the selected model. After execution, the runner saves a model-based review report and publishes a draft implementation PR from a branch tied to the run ID only if that report passes. The PR remains draft because model judgment is not proof of correctness.

## Agent harness and source-of-truth checks

T3 Code's architecture informs the ownership boundary: the execution environment owns Git, files, provider processes, and credentials; web clients control it over authenticated APIs. Its provider adapters, durable command/effect separation, PR links, and project-level settings are useful patterns. Fava adds a spec gate that T3 Code does not enforce. See [T3 Code architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) and [source control guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md). T3 Code is MIT licensed; no source files have been copied into this repository.

The intended full harness input is an immutable tuple: `{repository, mergedSpecCommit, specPath, model, skillVersions, mcpGrantIds, deploymentTarget}`. The current runner pins the first six fields, snapshots the latest 100 KB of agent stdout and stderr during execution, and saves the resulting diff under a run ID. Remote HTTP MCP server grants are approved per project and limited to named tools. The container receives a run-scoped capability; the outbound Worker checks the pinned grant, revocation state, and tool name on every call, then injects the encrypted server credential. A future run log must capture tool calls, test evidence, and previews before Fava can claim full inspection. Model adapters translate the task into Codex or Claude Code commands through AI Gateway. Fava does not assume a consumer Codex or Claude subscription can be transplanted into a shared cloud container; provider-supported authentication and explicit user consent determine each connection method.

Project skills live in `.fava/skills/*.md` in the target repository. A workspace may select shared skills from any linked repository using the same path. The run pins a commit for each selected skill at spec merge, so later edits cannot silently change an in-flight build. Up to eight skills may be selected per project, and each file is limited to 12 KB. Repository instructions such as `AGENTS.md` are imported as context, not executed as commands by the web service.

## Delivery sequence

1. Register the GitHub App and configure its callback, client secret, installation URL, and the Fava session secret. Verify a real sign-in, repository import, and spec PR.
2. Add D1 identity/project tables and a signed GitHub webhook endpoint. Make spec merge the only trigger for agent runs.
3. Deploy the vinext web Worker and separate Sandbox runner with the same D1 database, private R2 bucket, AI Gateway, and GitHub App credentials. Verify a real merge launches an isolated run. KV and Queues are still planned for cache and durable dispatch after account resources exist.
4. Add comprehensive run logs, stronger spec conformance checks, and preview URLs to the Sandbox runner; verify selected versioned skills and draft implementation PR publication against a live GitHub App.
5. Add Cloudflare Workers for Platforms deployment, then AWS/GCP deployment adapters. Verify project-scoped MCP grants against a live remote HTTP server.

## Current external blockers

The GitHub account has no registered Fava GitHub App; its credentials must be configured before sign-in and repository import work live. Wrangler is authenticated to the Cloudflare account, and `fava-core` D1 is provisioned with seven migrations, but the account has no Fava Worker and R2 is disabled. The available Cloudflare MCP serves documentation rather than account management. No live Fava Worker or branch Preview has been provisioned, so the code and diagram do not claim those external connections work.
