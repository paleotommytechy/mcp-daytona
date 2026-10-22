import {
  configureSandbox,
  destroySandbox,
  getManagedSandbox,
  listManagedSandboxes,
  manageSandbox,
  rerunCycle,
  runCycle,
  type AfterRun,
  type LifecycleSetting,
  type SandboxAction,
  type SandboxSnapshot,
  type SyncMode,
} from "./daytona";

const CURRENT_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = [CURRENT_PROTOCOL, LEGACY_PROTOCOL, "2025-06-18", "2025-03-26"] as const;
const SERVER_INFO = { name: "mcp-daytona", version: "0.5.0" } as const;
const SERVER_INSTRUCTIONS =
  "Use GitHub tools for source edits. run_cycle requires GitHub repositories in owner/repo form and automatically uses the GitHub App installation for that account or organization. rerun_cycle reuses a persistent checkout. Both accept an optional command and repo-relative path; path defaults to the repository root. When command is omitted, the standard QA runner executes.";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SANDBOX_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_CYCLE_TIMEOUT_SECONDS = process.env.VERCEL ? 240 : 3600;
const DEFAULT_CYCLE_TIMEOUT_SECONDS = process.env.VERCEL ? 240 : 1200;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_PATH_LENGTH = 512;
const SNAPSHOTS = [
  "daytona-small",
  "daytona-medium",
  "daytona-large",
  "daytona-vm-small",
  "daytona-vm-medium",
  "daytona-vm-large",
] as const satisfies readonly SandboxSnapshot[];

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;
type RpcRequest = Readonly<{ id?: JsonRpcId; method: string; params?: unknown }>;

type Tool = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: JsonRecord;
  annotations: JsonRecord;
}>;

const COMMAND_PROPERTIES = {
  command: {
    type: "string",
    minLength: 1,
    maxLength: MAX_COMMAND_LENGTH,
    description: "Optional shell command to run instead of the standard QA pipeline.",
  },
  path: {
    type: "string",
    minLength: 1,
    maxLength: MAX_PATH_LENGTH,
    default: ".",
    description: "Initial working directory relative to the repository root. Defaults to the root.",
  },
} as const;

const RUN_CYCLE_TOOL: Tool = {
  name: "run_cycle",
  title: "Run repository cycle",
  description:
    "Create a fresh managed Daytona sandbox, authenticate with the GitHub App installation for the requested owner/repo, clone the requested branch, then either run the supplied shell command from the supplied repo-relative path or run the standard QA pipeline when command is omitted.",
  inputSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
        description: "Required full GitHub repository in owner/repo form, for example Crown384/pamaos-next or Onestepsmarter/afri_cart. Bare repository names are invalid.",
      },
      branch: { type: "string", default: "main", description: "Existing GitHub branch." },
      ...COMMAND_PROPERTIES,
      timeout_seconds: { type: "integer", minimum: 60, maximum: MAX_CYCLE_TIMEOUT_SECONDS, default: DEFAULT_CYCLE_TIMEOUT_SECONDS },
      after_run: { type: "string", enum: ["delete", "keep", "stop", "pause"], default: "delete" },
      snapshot: { type: "string", enum: [...SNAPSHOTS], default: "daytona-medium" },
      auto_stop_minutes: {
        type: "integer",
        minimum: 0,
        maximum: 10080,
        default: 75,
        description: "Idle minutes before auto-stop. Use 0 to keep running indefinitely.",
      },
    },
    required: ["repository"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const RERUN_CYCLE_TOOL: Tool = {
  name: "rerun_cycle",
  title: "Rerun persistent sandbox cycle",
  description:
    "Reuse a managed Daytona sandbox, automatically mint a fresh GitHub App installation token for its repository, optionally sync its checkout, then either run the supplied shell command from the supplied repo-relative path or run the standard QA pipeline when command is omitted.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string" },
      ...COMMAND_PROPERTIES,
      timeout_seconds: { type: "integer", minimum: 60, maximum: MAX_CYCLE_TIMEOUT_SECONDS, default: DEFAULT_CYCLE_TIMEOUT_SECONDS },
      sync_mode: {
        type: "string",
        enum: ["reset", "none"],
        default: "reset",
        description: "reset fetches GitHub and hard-resets to origin/branch; none keeps the current checkout.",
      },
      after_run: { type: "string", enum: ["delete", "keep", "stop", "pause"], default: "keep" },
    },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const LIST_SANDBOXES_TOOL: Tool = {
  name: "list_sandboxes",
  title: "List managed sandboxes",
  description: "List only Daytona sandboxes created and labeled by this MCP server.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const GET_SANDBOX_TOOL: Tool = {
  name: "get_sandbox",
  title: "Get managed sandbox",
  description: "Get current Daytona details for one sandbox created by this MCP server.",
  inputSchema: {
    type: "object",
    properties: { sandbox_id: { type: "string" } },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const MANAGE_SANDBOX_TOOL: Tool = {
  name: "manage_sandbox",
  title: "Manage sandbox state",
  description:
    "Start/resume, stop, pause, or recover a managed sandbox. Pause requires a Daytona VM sandbox; container sandboxes should be stopped instead.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string" },
      action: { type: "string", enum: ["start", "stop", "pause", "recover"] },
    },
    required: ["sandbox_id", "action"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const CONFIGURE_SANDBOX_TOOL: Tool = {
  name: "configure_sandbox",
  title: "Configure sandbox lifecycle",
  description:
    "Change auto-stop, auto-pause, or auto-delete on a managed sandbox. auto_delete accepts -1 to disable deletion; other settings require 0 or more minutes.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string" },
      setting: { type: "string", enum: ["auto_stop", "auto_pause", "auto_delete"] },
      minutes: { type: "integer", minimum: -1, maximum: 10080 },
    },
    required: ["sandbox_id", "setting", "minutes"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const DESTROY_SANDBOX_TOOL: Tool = {
  name: "destroy_sandbox",
  title: "Destroy managed sandbox",
  description: "Permanently delete a Daytona sandbox created by this MCP server.",
  inputSchema: {
    type: "object",
    properties: { sandbox_id: { type: "string" } },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const TOOLS = [
  RUN_CYCLE_TOOL,
  RERUN_CYCLE_TOOL,
  LIST_SANDBOXES_TOOL,
  GET_SANDBOX_TOOL,
  MANAGE_SANDBOX_TOOL,
  CONFIGURE_SANDBOX_TOOL,
  DESTROY_SANDBOX_TOOL,
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): RpcRequest | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return undefined;
  let id: JsonRpcId | undefined;
  if ("id" in value) {
    const rawId = value.id;
    if (rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") return undefined;
    id = rawId;
  }
  return { ...(id === undefined ? {} : { id }), method: value.method, ...(value.params === undefined ? {} : { params: value.params }) };
}

function rpcResponse(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(id: JsonRpcId, text: string, structuredContent: unknown, isError = false): Response {
  return rpcResponse(id, { resultType: "complete", content: [{ type: "text", text }], structuredContent, isError });
}

function toolError(id: JsonRpcId, message: string): Response {
  return toolResult(id, message, { error: message }, true);
}

function argumentsOf(params: unknown): JsonRecord {
  if (!isRecord(params) || !isRecord(params.arguments)) return {};
  return params.arguments;
}

function stringValue(args: JsonRecord, key: string, pattern?: RegExp): string {
  const value = args[key];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${key} is invalid`);
  }
  return value;
}

function integerValue(args: JsonRecord, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumValue<T extends string>(args: JsonRecord, key: string, values: readonly T[], fallback?: T): T {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
    throw new Error(`${key} is invalid`);
  }
  return value as T;
}

function parseBranch(args: JsonRecord): string {
  const branch = args.branch === undefined ? "main" : stringValue(args, "branch", BRANCH_PATTERN);
  if (branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) throw new Error("branch is invalid");
  return branch;
}

function parseSandboxId(args: JsonRecord): string {
  return stringValue(args, "sandbox_id", SANDBOX_PATTERN);
}

function parseCommand(args: JsonRecord): string | undefined {
  if (args.command === undefined) return undefined;
  const command = stringValue(args, "command");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`);
  return command;
}

function parseWorkingPath(args: JsonRecord): string {
  if (args.path === undefined) return ".";
  const path = stringValue(args, "path");
  if (path.length > MAX_PATH_LENGTH || path.includes("\0")) throw new Error("path is invalid");
  if (/^(?:\/|\\|[A-Za-z]:)/.test(path)) throw new Error("path must be relative to the repository root");
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error("path cannot traverse outside the repository");
  }
  return path;
}

function supportsProtocol(version: string): boolean {
  return SUPPORTED_PROTOCOLS.some((supported) => supported === version);
}

function initializeResult(params: unknown): JsonRecord {
  const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : LEGACY_PROTOCOL;
  return {
    protocolVersion: supportsProtocol(requested) ? requested : LEGACY_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  };
}

function discoveryResult(): JsonRecord {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOLS,
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: "public",
  };
}

async function executeTool(name: string, args: JsonRecord): Promise<{ text: string; data: unknown; failed?: boolean }> {
  if (name === "run_cycle") {
    const afterRun = enumValue<AfterRun>(args, "after_run", ["delete", "keep", "stop", "pause"], "delete");
    const snapshot = enumValue<SandboxSnapshot>(args, "snapshot", SNAPSHOTS, "daytona-medium");
    if (afterRun === "pause" && !snapshot.startsWith("daytona-vm-")) {
      throw new Error("after_run=pause requires a daytona-vm-* snapshot");
    }
    const data = await runCycle({
      repository: stringValue(args, "repository", REPOSITORY_PATTERN),
      branch: parseBranch(args),
      command: parseCommand(args),
      workingPath: parseWorkingPath(args),
      timeoutSeconds: integerValue(args, "timeout_seconds", DEFAULT_CYCLE_TIMEOUT_SECONDS, 60, MAX_CYCLE_TIMEOUT_SECONDS),
      afterRun,
      snapshot,
      autoStopMinutes: integerValue(args, "auto_stop_minutes", 75, 0, 10080),
    });
    const failed = data.exitCode !== 0 || data.lifecycleStatus === "failed";
    return { text: `Daytona cycle ${failed ? "failed" : "completed"} for ${data.repository}@${data.branch}. Sandbox: ${data.sandboxId}.`, data, failed };
  }

  if (name === "rerun_cycle") {
    const data = await rerunCycle({
      sandboxId: parseSandboxId(args),
      command: parseCommand(args),
      workingPath: parseWorkingPath(args),
      timeoutSeconds: integerValue(args, "timeout_seconds", DEFAULT_CYCLE_TIMEOUT_SECONDS, 60, MAX_CYCLE_TIMEOUT_SECONDS),
      syncMode: enumValue<SyncMode>(args, "sync_mode", ["reset", "none"], "reset"),
      afterRun: enumValue<AfterRun>(args, "after_run", ["delete", "keep", "stop", "pause"], "keep"),
    });
    const failed = data.exitCode !== 0 || data.lifecycleStatus === "failed";
    return { text: `Daytona rerun ${failed ? "failed" : "completed"} for ${data.repository}@${data.branch}.`, data, failed };
  }

  if (name === "list_sandboxes") {
    const data = await listManagedSandboxes();
    return { text: "Managed Daytona sandboxes listed.", data: { sandboxes: data } };
  }

  if (name === "get_sandbox") {
    const sandboxId = parseSandboxId(args);
    return { text: `Managed sandbox ${sandboxId} loaded.`, data: { sandbox: await getManagedSandbox(sandboxId) } };
  }

  if (name === "manage_sandbox") {
    const sandboxId = parseSandboxId(args);
    const action = enumValue<SandboxAction>(args, "action", ["start", "stop", "pause", "recover"]);
    await manageSandbox(sandboxId, action);
    return { text: `Sandbox ${sandboxId}: ${action} accepted.`, data: { sandboxId, action } };
  }

  if (name === "configure_sandbox") {
    const sandboxId = parseSandboxId(args);
    const setting = enumValue<LifecycleSetting>(args, "setting", ["auto_stop", "auto_pause", "auto_delete"]);
    const minutes = integerValue(args, "minutes", 0, -1, 10080);
    if (setting !== "auto_delete" && minutes < 0) throw new Error(`${setting} cannot be negative`);
    await configureSandbox(sandboxId, setting, minutes);
    return { text: `Sandbox ${sandboxId}: ${setting} set to ${minutes}.`, data: { sandboxId, setting, minutes } };
  }

  if (name === "destroy_sandbox") {
    const sandboxId = parseSandboxId(args);
    await destroySandbox(sandboxId);
    return { text: `Sandbox ${sandboxId} deletion accepted.`, data: { sandboxId, deleted: true } };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function callTool(id: JsonRpcId, params: unknown, headerToolName: string | null): Promise<Response> {
  if (!isRecord(params)) return toolError(id, "tools/call requires object params");
  const name = typeof params.name === "string" ? params.name : headerToolName;
  if (!name) return toolError(id, "Tool name is missing");

  try {
    const result = await executeTool(name, argumentsOf(params));
    return toolResult(id, result.text, result.data, result.failed ?? false);
  } catch (error) {
    return toolError(id, error instanceof Error ? error.message : String(error));
  }
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const rpc = parseRequest(payload);
  if (!rpc) return rpcError(null, -32600, "Invalid Request");
  if (rpc.id === undefined) return new Response(null, { status: 202 });

  switch (rpc.method) {
    case "initialize":
      return rpcResponse(rpc.id, initializeResult(rpc.params));
    case "server/discover":
      return rpcResponse(rpc.id, discoveryResult());
    case "tools/list":
      return rpcResponse(rpc.id, { resultType: "complete", tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" });
    case "tools/call":
      return callTool(rpc.id, rpc.params, request.headers.get("Mcp-Name"));
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}
