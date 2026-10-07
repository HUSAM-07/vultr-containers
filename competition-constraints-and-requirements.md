# Vultr: Agent Rush — competition constraints and requirements

Checked 7 October 2026 against the [official hackathon page](https://lablab.ai/ai-hackathons/vultr-hackathon). Rules and partner tracks can change before kickoff.

## Event and submission

- Online build: **3–8 November 2026**. On-site showcase: **8 November 2026**, subject to approval. Teams: **1–6**.
- Register on lablab.ai and join the event Discord. The credit offer is **$200 per participant**; the redemption coupon has not been published yet.
- Submit a **public GitHub repository** with setup and architecture docs, a **public browser demo URL**, and a **recorded demo video**. The lablab submission also asks for title, short and long descriptions, tags, cover image, video, and slide presentation.
- The video must include one containment moment: an unsafe action such as an infinite loop or destructive operation stopped by the sandbox.
- Judging emphasizes application of technology, presentation, business value, and originality. Submissions must be original and MIT-compliant. Confirm final eligibility and any announced partner track before submitting.

## Non-negotiable architecture

| Requirement | This project |
| --- | --- |
| Web-based, product-style agent that performs real work | Forge frontend at `web/`; task, project, history, run inspector, static HTML preview, source and execution receipts |
| Backend control and orchestration on a **Vultr VM** | `server/index.mjs` must be deployed on a Vultr VM; Vercel only serves the frontend and a thin proxy |
| **All submitted agent LLM calls** through Vultr Serverless Inference | Vultr is the backend default. Local development can explicitly opt into OpenRouter GPT-6 Luna, but the hackathon deployment must leave `INFERENCE_PROVIDER` unset |
| Code or browser actions in an isolated sandbox **on Vultr** | Docker container per code task on the Vultr VM, outside the Node app process |
| Multi-step workflow with verifiable executed result | Model plan → generated code → container stdout/stderr and optional HTML preview → one repair retry on failure |
| Containment controls | Network disabled, read-only root, non-root user, dropped capabilities, CPU/memory/process limits, 12-second timeout, container removal |
| Public demo and proof | **Pending deployment**: public Vercel URL, Vultr VM, recorded video, screenshot/receipt of containment run |

Source: [lablab.ai challenge and developer expectations](https://lablab.ai/ai-hackathons/vultr-hackathon).

## Deployment boundary

```text
Browser → Vercel Next.js UI and server proxy → HTTPS → Vultr VM Node control API
                                                  ├→ Vultr Serverless Inference
                                                  └→ disposable Docker Python container
```

Vercel hosts the experience, but cannot replace the required Vultr control backend. The backend must run the whole planning, dispatch, execution, and verification loop. Set the Vercel project's root directory to `web`, per [Vercel monorepo guidance](https://vercel.com/docs/monorepos). Keep both Vultr inference and backend tokens server-side.

## Candidate ideas

| Idea | Real executed result | Why it could compete |
| --- | --- | --- |
| **Forge product builder and manager** (selected) | Task-specific code, test output, static HTML previews, retries, persistent run history | Reusable control layer with an explicit sandbox receipt |
| CSV repair studio | Cleaned dataset, before/after diff, validation log | Clear business value and easy proof |
| Prove-It code reviewer | Executes a submitted repro or test suite | Strong contrast between claims and measured behavior |
| Site QA sweep | Playwright screenshots, broken flow report | Visual demo, but needs browser sandbox and approval gate |
| Chart Anything | Executed chart image plus source and data | Fast demo, but artifact handling is required |
| Research with receipts | Screenshots tied to claims | Requires browser isolation and source validation |

The selected first slice is code execution with an optional static HTML preview emitted by the container. Browser automation, artifact uploads, and external write actions can follow after the containment path is proven.

## Services and infrastructure

- **Required:** Vultr Cloud Compute VM, Vultr Serverless Inference, Docker sandbox runtime, public Vercel deployment.
- **Current prototype:** one Vultr VM, Node 24+ API, per-task Docker container, local persisted JSON run history scoped to signed browser sessions, Next.js frontend on Vercel. The VM should have a persistent data disk, HTTPS reverse proxy, and Docker image pre-pulled.
- **As scope grows:** Convex for organization-scoped durable data from the attached ADLC specification; Vultr Object Storage or Cloudflare R2 for private artifacts; queue/worker separation for long jobs; browser sandbox with Playwright; observability and per-tenant IAM. These are **not implemented** in this slice.
- **Budget guardrails:** two concurrent runs, 50 starts/day by default, 12 seconds/container, 256 MiB/container. Set a Vultr spend alert before exposing the public demo.

## Attached ADLC platform specification

The attached draft describes a much broader organization-scoped platform: Slack, web, CLI, Telegram, Convex, Cloudflare storage, IAM/IdP, external connectors, durable event/outbox contracts and approvals. Those are **future platform requirements**, not hackathon rules and not claims about this prototype. This implementation honors the latest Vercel frontend direction while preserving a path to Convex and object storage. Before real organization onboarding, the ADLC decisions on IdP, tenant policy, retention, provider capabilities, and controlled writes must be resolved. Do not connect production credentials or expose multi-tenant data in this prototype.

## WASM decision

**WASM is not required.** BoardUI and Spectrum UI tooling run at development time through Node/npm; they do not run inside task sandboxes. The challenge explicitly accepts Docker containers or throwaway instances on Vultr. Python execution and future Playwright browser use fit ordinary Linux containers. WebAssembly is optional for narrower workloads with a WASI runtime, but adds a new compatibility layer without satisfying the VM/inference requirements by itself. Docker documents Wasmtime container support as [experimental](https://docs.docker.com/engine/daemon/alternative-runtimes/).

## Launch checklist

- [x] Competition folder and named feature branch
- [x] Official free BoardUI components and Spectrum UI MCP project registration
- [x] Vercel frontend, Vultr VM backend code, Vultr-default inference endpoint
- [x] Isolated Docker command and a containment-demo flow
- [x] Plan, sandbox guard, preview, and visitor isolation checks; frontend production build
- [ ] Provision Vultr VM, HTTPS and server-only credentials; pull `python:3.12-alpine`; confirm OpenRouter override is unset
- [ ] Exercise a real inference call and Docker run on that VM
- [ ] Deploy Vercel frontend with `web` root and backend URL/token
- [ ] Confirm public URL, record video with containment moment, submit slides/cover
- [ ] Recheck official page for final rules and partner tracks before 3 November
