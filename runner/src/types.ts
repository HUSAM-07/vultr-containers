import type { AgentSandbox } from "./sandbox";

export type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  SANDBOX: DurableObjectNamespace<AgentSandbox>;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  FAVA_RUN_SECRET: string;
  FAVA_SESSION_SECRET: string;
};

export type RunJob = {
  id: string;
  repository: string;
  repositoryId: number;
  installationId: number;
  sha: string;
  specPath: string;
  provider: "openai" | "anthropic";
  model: "gpt-6-sol" | "claude-sonnet-5";
  skills: string;
  mcpGrantIds: string[];
};
