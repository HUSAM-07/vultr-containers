# Fava technical design

The editable diagram is [fava-platform.drawio](fava-platform.drawio). Open it in diagrams.net. A Draw.io MCP tool is not available in this workspace, so the diagram is stored in Draw.io's native XML format.

## Product contract

1. A person signs in with a GitHub App user authorization. Fava lists only repositories available to both that user and the App installation.
2. Selecting a repository imports its file map and a small set of project instructions. GitHub remains the source of truth for code and specifications.
3. A person writes `specs/<slug>-<id>.md` with an outcome, scope, and acceptance criteria. Fava creates a `spec/<slug>-<id>` branch and a spec-only pull request.
4. No coding agent may run for that change until the spec PR is merged into the repository's default branch. A GitHub webhook, verified with the App webhook secret, records the merged spec commit and schedules implementation.
5. An isolated agent workspace checks out that exact commit. The agent receives the spec, selected project/shared skills, bounded repository context, chosen model, and approved MCP connections. It opens an implementation PR with test evidence and a preview URL.
6. A spec conformance check compares changed files and behavior against acceptance criteria. Unrelated changes are flagged or removed before the implementation PR is marked ready.

The current implementation covers steps 1–3 locally once a GitHub App is configured. The workspace also lists recent spec-only pull requests and their GitHub status; no agent starts from that list yet. The web app builds and serves locally as a Cloudflare Worker with vinext. The existing Forge demo is available at `/demo`; it is not connected to the merged-spec gate.

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

The initial D1 schema is in [`infra/cloudflare/0001_core.sql`](../infra/cloudflare/0001_core.sql). CI checks its relational constraints with SQLite. The app does not yet bind D1 or write these tables; account roles, revocation, and run state remain unimplemented at runtime.

## Identity and GitHub integration

- GitHub App permissions: **Metadata: read**, **Contents: read/write**, **Pull requests: read/write**. Subscribe to `pull_request`, `installation`, `installation_repositories`, and `github_app_authorization` webhooks when the webhook worker exists.
- OAuth uses state and PKCE. The current session is an AES-GCM encrypted, HTTP-only, SameSite=Lax cookie with token refresh. A production multi-tenant service will store sessions and encrypted provider credentials server-side in D1/R2 with a dedicated key-management policy; the cookie will then contain an opaque session ID.
- Fava account identity is the immutable GitHub user ID. Organization and project roles will be owner, admin, editor, viewer. Every API call must enforce Fava role **and** current GitHub installation/repository permission. Installation changes and revoked authorizations invalidate access.
- GitHub API writes use the person's GitHub App user token, so the audit trail attributes the action to that person. Webhook-triggered work uses an installation token restricted to the single repository.
- A spec PR contains only `specs/<slug>.md`. Branch protection and CI should require human approval before merge. The webhook checks that the merged PR changed a spec path and records its merge commit; duplicate deliveries must be harmless.

## Agent harness and source-of-truth checks

T3 Code's architecture informs the ownership boundary: the execution environment owns Git, files, provider processes, and credentials; web clients control it over authenticated APIs. Its provider adapters, durable command/effect separation, PR links, and project-level settings are useful patterns. Fava adds a spec gate that T3 Code does not enforce. See [T3 Code architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) and [source control guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md). T3 Code is MIT licensed; no source files have been copied into this repository.

The harness input is an immutable tuple: `{repository, mergedSpecCommit, specPath, model, skillVersions, mcpGrantIds, deploymentTarget}`. The runner records every command, tool call, output, diff, test result, and preview link under a run ID. A model adapter translates the normalized task into a provider-specific session. Fava must not assume that a consumer Codex or Claude subscription can be transplanted into a shared cloud container; provider-supported authentication and explicit user consent determine each connection method.

Project skills live in `.fava/skills/*.md` in the target repository. Shared skills live in a dedicated versioned Fava skills repository. The run pins a commit for each skill, so later edits cannot silently change an in-flight build. Repository instructions such as `AGENTS.md` are imported as context, not executed as commands by the web service.

## Delivery sequence

1. Register the GitHub App and configure its callback, client secret, installation URL, and the Fava session secret. Verify a real sign-in, repository import, and spec PR.
2. Add D1 identity/project tables and a signed GitHub webhook endpoint. Make spec merge the only trigger for agent runs.
3. Deploy the existing vinext build to Workers. Bind D1, R2, KV, and Queues after their account resources exist.
4. Replace the demo Python-only runner with the Cloudflare Sandbox harness, model adapters, selected skills, run logs, implementation PRs, and preview URLs.
5. Add Cloudflare Workers for Platforms deployment, then AWS/GCP deployment adapters and project-scoped MCP grants.

## Current external blockers

The GitHub account has no registered GitHub Apps, and developer settings require account verification before registration. Cloudflare's GitHub sign-in returned an error; the dashboard is at its sign-in page. No Cloudflare management credentials or CLI login are available in this environment, and no live Cloudflare resource has been provisioned. The code and diagram are prepared without claiming those external connections work.
