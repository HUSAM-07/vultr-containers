# Fava — spec-first software building

Fava's first connected workflow lets a person sign in through a GitHub App, link an installed repository to a personal Fava account, import its file map and project instructions, write a specification, and open a spec pull request. The specification is stored in GitHub under `specs/`. The [technical design](docs/fava-architecture.md) and editable [Draw.io diagram](docs/fava-platform.drawio) cover the planned merged-spec gate, agent harness, identity layer, and Cloudflare services.

The landing page is `/`, the spec workspace is `/app`, and the existing Forge agent demo is `/demo`. The GitHub App is not registered yet, so account connection and a real spec PR still need live verification. The Cloudflare Workers build runs locally through vinext; no Cloudflare deployment has been made.

## GitHub App setup

1. Register a GitHub App with callback URL `http://127.0.0.1:3001/api/github/auth/callback` for the local Worker preview. Give it repository **Metadata: read**, **Contents: read/write**, and **Pull requests: read/write**. Enable expiring user access tokens. Install it only on repositories you want Fava to access. For a deployed Worker, set the App webhook URL to `https://<your-worker-domain>/api/github/webhook`, configure a webhook secret, and subscribe to `pull_request` events.
2. Copy `web/.env.example` to `web/.dev.vars`. Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, the downloaded App `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. Generate a random `FAVA_SESSION_SECRET` of at least 32 characters. Keep these values out of Git.
3. Build and start the Cloudflare Worker preview as below, apply the local D1 schema, then open `http://127.0.0.1:3001/app`. Connect GitHub, choose an installed repository, and create a spec PR. The repository needs a nonempty default branch.

GitHub sign-in creates a personal account in D1, and choosing a repository links it as a project. The editor records a Codex or Claude Code model with each spec PR. A signed webhook records its merge only when the PR adds exactly that spec file and the merged contents still pass validation, then queues one run in D1. The workspace lets a user select up to eight `.fava/skills/*.md` files from linked repositories for a project or personal workspace. Each run pins the selected skill commits when its spec merges, and the runner loads those exact versions. The workspace shows recent run records. The runner code exists but has not been deployed, so queued runs do not execute in a live account. Each encrypted, HTTP-only session cookie is checked against a revocable D1 record; logout revokes that record. Organization roles and GitHub authorization revocation handlers remain pending.

## Cloudflare Workers build

From `web/`, run `npm run build:vinext` and `npm run start:vinext -- --host 127.0.0.1 --port 3001`. In another terminal, run `npm run db:migrate:local`; it applies the six D1 migrations when needed. This serves the built Worker and its simulated D1 database at `http://127.0.0.1:3001`. The connected Cloudflare account already has the `fava-core` D1 database with all six migrations applied. `npm run deploy:vinext` still needs the GitHub/session secrets and the R2 artifact bucket. The Next.js/Vercel build remains available for the Forge demo; Fava account storage runs on Cloudflare.

### Connected Worker Previews

After linking a GitHub repository in `/app`, connect a Cloudflare account with a **user-scoped** API token. Give it **Workers Scripts: Read** and **Workers Builds Configuration: Edit** for the selected account. Fava encrypts the token with a key derived from `FAVA_SESSION_SECRET` and stores it in D1; disconnecting deletes the stored token. Each linked project chooses an existing Worker in that account. The Worker must already be connected to that same GitHub repository through Workers Builds, which requires the one-time [Cloudflare GitHub App installation](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/).

The repository needs `wrangler.jsonc` or `wrangler.json` at its root, with a `previews` block. For every production D1, R2, or KV binding, provide the same binding name in `previews` pointing to a **different** Preview resource. Set Preview variables and secrets separately. Fava checks those storage identities before it creates or updates the Worker Builds Preview trigger. Branch pushes then run `npx wrangler preview`; Cloudflare comments Preview URLs on GitHub pull requests. Previews are public by default; use Cloudflare Access when a project requires private previews. Cloudflare's [Preview configuration guide](https://developers.cloudflare.com/workers/previews/configuration/) explains other settings and binding behavior. Existing Cloudflare Builds continue after disconnecting Fava; disable the trigger in Cloudflare to stop them.

## Cloudflare agent runner

`runner/` is a separate scheduled Worker. Every minute it claims runs only for merged, validated specs, starts one Cloudflare Sandbox container per run, checks out the exact merge commit, and runs the selected Codex or Claude Code model through AI Gateway. GitHub installation and gateway tokens stay in the Worker. It saves bounded logs and the resulting diff in private R2; the Fava workspace exposes them only to the linked account. A completed run creates a draft implementation PR from the pinned merge commit on an `impl/<run-id>` branch. It refuses changes to specs and instruction files, limits output to 25 regular files and 1 MB of content, and reuses an existing run branch after retries. Automated semantic spec conformance and deployment previews are still pending; a draft PR is not a conformance verdict.

Before deploying, use a [Workers Paid plan](https://developers.cloudflare.com/sandbox/), configure AI Gateway with OpenAI and Anthropic access, and bind both Workers to the **same** `fava-core` D1 database. Its six migrations (`0001_core.sql` through `0006_run_skills.sql`) are applied in the connected account. Enable R2 in the Cloudflare dashboard, then create the private `fava-run-artifacts` bucket. The runner's D1 ID is already configured. Set `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_TOKEN`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY`, and a random `FAVA_RUN_SECRET` of at least 32 characters as runner secrets; set the gateway ID in `wrangler.jsonc` if it differs from `default`. Then run `npm ci`, `npm test`, `npm run typecheck`, and `npm run deploy` from `runner/`. The container image build requires a working Docker-compatible engine.

## Forge — Vultr Agent Rush demo

Product task manager and sandboxed coding agent for the [Vultr: Agent Rush Hackathon](https://lablab.ai/ai-hackathons/vultr-hackathon). UI tasks can produce a static HTML preview from code executed inside the container. [Requirements and ideas](competition-constraints-and-requirements.md).

## Run locally

Requires Node 24+ and Docker for executing agent code. The containment demo does not call a model.

1. Copy `server/.env.example` to `server/.env` and set a long random `WEB_BACKEND_TOKEN`. For local model development, set `INFERENCE_PROVIDER=openrouter` and `OPENROUTER_API_KEY`; this uses `openai/gpt-6-luna`. For a competition-ready run, leave `INFERENCE_PROVIDER` unset and set `VULTR_INFERENCE_API_KEY` and `VULTR_MODEL`.
2. Copy `web/.env.example` to `web/.env.local`; use the same token as `VULTR_BACKEND_TOKEN`.
3. Pull the sandbox image: `docker pull python:3.12-alpine`.
4. Start the backend: `set -a; source server/.env; set +a; npm run dev:api`.
5. In another terminal: `cd web && npm install && npm run dev`.
6. Open `http://localhost:3000/demo`.

`npm test` checks plan validation, Docker isolation flags, inference routes, visitor session isolation, preview extraction, spec validation and publishing, and encrypted sessions. `npm run build` builds the Next.js frontend. The Forge conversation and repository names are visual examples until a real task is selected.

## Deploy

**Vultr VM:** Install Node 24+ and Docker, create a non-root application user, pre-pull `python:3.12-alpine`, provide the server environment variables through a protected service environment, and run `node server/index.mjs` behind HTTPS. **Leave `INFERENCE_PROVIDER` unset** so every agent model call uses Vultr Serverless Inference, as the hackathon requires. Allow incoming traffic only to the reverse proxy. Restrict access to Docker; its socket is host-powerful. Keep `server/data/` on persistent storage and back it up, or set `FORGE_DATA_FILE` to another persistent path. This single-process JSON store is a hackathon ceiling; use Convex and a durable queue before multi-tenant production.

**Vercel:** Import the GitHub repository with **Root Directory = `web`**. Set `VULTR_BACKEND_URL` to the VM's HTTPS API origin and `VULTR_BACKEND_TOKEN` to the same backend secret. These variables are server-only. Vercel serves the UI and forwards API requests; all agent model calls and sandbox execution remain on Vultr. Publish the Vercel URL as the demo application URL.

The public demo issues each browser a signed, HTTP-only session cookie and scopes run history to it. It also has a global capacity cap. Sessions are browser-local and are not user accounts; clearing cookies loses access to earlier runs. Do not use the demo for private data or real organization integrations. Add authentication and tenant enforcement before broad deployment.

## UI provenance

- [BoardUI](https://www.boardui.com/components) free button, input, textarea, and agent-thinking components with its semantic theme, installed with the official CLI. The three-region layout recreates the supplied [AI Chat reference](https://www.boardui.com/templates/ai-chat) using free components; it does not include Pro source.
- [Spectrum UI Agent Steps](https://ui.spectrumhq.in/blocks/ai-assistants#agent-steps) adapted to the BoardUI theme; project MCP configuration is in `.mcp.json`. The adapted component retains Apache 2.0 attribution.

## Current limits

Runs and inline HTML previews are retained as JSON on one VM; interrupted runs are marked failed on restart. Project names are browser-local. No account system, downloadable artifact files, browser automation, or external write approvals yet. Generated previews have scripts, network requests, and forms blocked by iframe sandbox and CSP. The attached ADLC specification covers those later phases.
