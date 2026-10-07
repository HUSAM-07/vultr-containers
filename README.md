# Forge — Vultr Agent Rush

Product task manager and sandboxed coding agent for the [Vultr: Agent Rush Hackathon](https://lablab.ai/ai-hackathons/vultr-hackathon). UI tasks can produce a static HTML preview from code executed inside the container. [Requirements and ideas](competition-constraints-and-requirements.md).

## Run locally

Requires Node 24+ and Docker for executing agent code. The containment demo does not call a model.

1. Copy `server/.env.example` to `server/.env` and set a long random `WEB_BACKEND_TOKEN`. For local model development, set `INFERENCE_PROVIDER=openrouter` and `OPENROUTER_API_KEY`; this uses `openai/gpt-6-luna`. For a competition-ready run, leave `INFERENCE_PROVIDER` unset and set `VULTR_INFERENCE_API_KEY` and `VULTR_MODEL`.
2. Copy `web/.env.example` to `web/.env.local`; use the same token as `VULTR_BACKEND_TOKEN`.
3. Pull the sandbox image: `docker pull python:3.12-alpine`.
4. Start the backend: `set -a; source server/.env; set +a; npm run dev:api`.
5. In another terminal: `cd web && npm install && npm run dev`.
6. Open `http://localhost:3000`.

`npm test` checks plan validation, Docker isolation flags, both inference routes, visitor session isolation, and preview extraction; `npm run build` builds the frontend. The opening conversation and repository names are visual examples until a real task is selected.

## Deploy

**Vultr VM:** Install Node 24+ and Docker, create a non-root application user, pre-pull `python:3.12-alpine`, provide the server environment variables through a protected service environment, and run `node server/index.mjs` behind HTTPS. **Leave `INFERENCE_PROVIDER` unset** so every agent model call uses Vultr Serverless Inference, as the hackathon requires. Allow incoming traffic only to the reverse proxy. Restrict access to Docker; its socket is host-powerful. Keep `server/data/` on persistent storage and back it up, or set `FORGE_DATA_FILE` to another persistent path. This single-process JSON store is a hackathon ceiling; use Convex and a durable queue before multi-tenant production.

**Vercel:** Import the GitHub repository with **Root Directory = `web`**. Set `VULTR_BACKEND_URL` to the VM's HTTPS API origin and `VULTR_BACKEND_TOKEN` to the same backend secret. These variables are server-only. Vercel serves the UI and forwards API requests; all agent model calls and sandbox execution remain on Vultr. Publish the Vercel URL as the demo application URL.

The public demo issues each browser a signed, HTTP-only session cookie and scopes run history to it. It also has a global capacity cap. Sessions are browser-local and are not user accounts; clearing cookies loses access to earlier runs. Do not use the demo for private data or real organization integrations. Add authentication and tenant enforcement before broad deployment.

## UI provenance

- [BoardUI](https://www.boardui.com/components) free button, input, textarea, and agent-thinking components with its semantic theme, installed with the official CLI. The three-region layout recreates the supplied [AI Chat reference](https://www.boardui.com/templates/ai-chat) using free components; it does not include Pro source.
- [Spectrum UI Agent Steps](https://ui.spectrumhq.in/blocks/ai-assistants#agent-steps) adapted to the BoardUI theme; project MCP configuration is in `.mcp.json`. The adapted component retains Apache 2.0 attribution.

## Current limits

Runs and inline HTML previews are retained as JSON on one VM; interrupted runs are marked failed on restart. Project names are browser-local. No account system, downloadable artifact files, browser automation, or external write approvals yet. Generated previews have scripts, network requests, and forms blocked by iframe sandbox and CSP. The attached ADLC specification covers those later phases.
