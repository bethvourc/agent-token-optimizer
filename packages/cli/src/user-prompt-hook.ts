import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  UserPromptHookEvidenceSchema,
  STORE_KINDS,
  SqliteStore,
  analyzeWorkspace,
  assessTask,
  buildContextPack,
  discoverWorkspace,
  estimateTextTokens,
  getWorkspaceIdentity,
  mergeTokenLedger,
  rankContext,
  redactText,
  type UserPromptHookEvidence,
  type ContextPack,
  type TaskAssessment,
  type WorkspaceAnalysisIndex,
  type WorkspaceConfiguration,
} from "@agent-relay/agent-token-optimization-core";

export const DEFAULT_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET = 1_200;
export const MAX_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET = 2_000;
export const MAX_USER_PROMPT_HOOK_INPUT_BYTES = 1_048_576;
export const DEFAULT_USER_PROMPT_HOOK_TIME_LIMIT_MS = 25_000;

export interface UserPromptHookInput {
  readonly hook_event_name: "UserPromptSubmit";
  readonly cwd: string;
  readonly prompt: string;
  readonly session_id?: string;
  readonly turn_id?: string;
}

export interface UserPromptHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "UserPromptSubmit";
    readonly additionalContext: string;
  };
}

export interface UserPromptHookResult {
  readonly output?: UserPromptHookOutput;
  readonly evidence: UserPromptHookEvidence;
}

export interface RunUserPromptHookOptions {
  readonly cachePath: string;
  readonly cacheEnabled?: boolean;
  readonly packageVersion?: string;
  readonly responseTokenBudget?: number;
  readonly recommendedContentTokenBudget?: number;
  readonly optimization?: WorkspaceConfiguration["optimization"];
  readonly operationId?: string;
  readonly now?: Date;
  readonly timeLimitMs?: number;
}

export function parseUserPromptHookInput(serialized: string): UserPromptHookInput {
  if (Buffer.byteLength(serialized) > MAX_USER_PROMPT_HOOK_INPUT_BYTES) {
    throw new TypeError("User-prompt hook input exceeds the 1 MiB safety limit.");
  }

  let value: unknown;

  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("User-prompt hook input must be valid JSON.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("User-prompt hook input must be a JSON object.");
  }

  const record = value as Record<string, unknown>;

  if (record.hook_event_name !== "UserPromptSubmit") {
    throw new TypeError("User-prompt hook event must be UserPromptSubmit.");
  }

  const cwd = readBoundedString(record.cwd, "cwd", 4_096);
  const prompt = readPromptText(record.prompt).trim();

  if (!prompt) {
    throw new TypeError("User-prompt hook prompt must not be empty.");
  }
  if (!cwd.trim()) {
    throw new TypeError("User-prompt hook cwd must not be empty.");
  }

  return {
    hook_event_name: "UserPromptSubmit",
    cwd,
    prompt,
    ...optionalBoundedString(record.session_id, "session_id", 500),
    ...optionalBoundedString(record.turn_id, "turn_id", 500),
  };
}

export async function runUserPromptHook(
  input: UserPromptHookInput,
  options: RunUserPromptHookOptions,
): Promise<UserPromptHookResult> {
  const startedAt = performance.now();
  const generatedAt = (options.now ?? new Date()).toISOString();
  const operationId = options.operationId ?? randomUUID();
  const packageVersion = options.packageVersion ?? "0.1.0";
  const cacheEnabled = options.cacheEnabled ?? true;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_USER_PROMPT_HOOK_TIME_LIMIT_MS;
  assertTimeLimit(timeLimitMs);
  const responseTokenBudget =
    options.responseTokenBudget ?? DEFAULT_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET;
  assertResponseTokenBudget(responseTokenBudget);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("User-prompt hook processing timed out.")),
    timeLimitMs,
  );
  timeout.unref();
  let store: SqliteStore | undefined;

  try {
    const workspaceIdentity = await getWorkspaceIdentity(input.cwd);
    const taskHash = hashText(input.prompt);
    const initialAssessment = assessTask({ task: input.prompt });
    store = cacheEnabled
      ? new SqliteStore({ databasePath: options.cachePath })
      : undefined;
    await store?.initialize();
    abortController.signal.throwIfAborted();
    if (initialAssessment.mode === "skip") {
      const evidence = createEvidence({
        assessment: initialAssessment,
        cacheEnabled,
        durationMs: elapsedMilliseconds(startedAt),
        generatedAt,
        operationId,
        outcome: "skipped",
        packageVersion,
        responseTokenBudget,
        responseTokens: 0,
        selectedFiles: [],
        taskHash,
        workspaceRootHash: workspaceIdentity.rootHash,
      });
      await persistHookEvidence({
        evidence,
        operationId,
        prompt: input.prompt,
        store,
        workspaceRootHash: workspaceIdentity.rootHash,
      });

      return { evidence };
    }

    const cacheKey = `${workspaceIdentity.rootHash}:latest`;
    const [previousWorkspaceIndex, previousWorkspaceAnalysis] = store
      ? await Promise.all([
          store.get(STORE_KINDS.workspaceIndex, cacheKey),
          store.get(STORE_KINDS.workspaceAnalysis, cacheKey),
        ])
      : [undefined, undefined];
    const optimization = options.optimization;
    const workspaceIndex = await discoverWorkspace({
      rootPath: input.cwd,
      packageVersion,
      operationId,
      includeContentHashes: true,
      ...(optimization?.maxFileSizeBytes
        ? { maxFileSizeBytes: optimization.maxFileSizeBytes }
        : {}),
      ...(optimization?.maxFiles ? { maxFiles: optimization.maxFiles } : {}),
      ...(optimization?.maxTotalBytes !== undefined
        ? { maxTotalBytes: optimization.maxTotalBytes }
        : {}),
      ...(optimization?.concurrency ? { concurrency: optimization.concurrency } : {}),
      ...(optimization?.extraIgnorePatterns
        ? { extraIgnorePatterns: optimization.extraIgnorePatterns }
        : {}),
      ...(optimization?.supportedLanguages
        ? { supportedLanguages: optimization.supportedLanguages }
        : {}),
      ...(previousWorkspaceIndex ? { previousIndex: previousWorkspaceIndex } : {}),
      signal: abortController.signal,
    });
    abortController.signal.throwIfAborted();
    const workspaceAnalysis = await analyzeWorkspace({
      workspaceIndex,
      packageVersion,
      operationId,
      ...(previousWorkspaceAnalysis ? { previousIndex: previousWorkspaceAnalysis } : {}),
    });
    abortController.signal.throwIfAborted();
    const assessment = assessTask({
      task: input.prompt,
      workspaceIndex,
      workspaceAnalysis,
    });
    const rankedContext = rankContext({
      task: input.prompt,
      workspaceIndex,
      workspaceAnalysis,
      taskHints: assessment.hints,
      ...(optimization?.rankingLimit ? { limit: optimization.rankingLimit } : {}),
      ...(optimization?.selectionThreshold !== undefined
        ? { selectionThreshold: optimization.selectionThreshold }
        : {}),
    });
    const contextPack = await buildContextPack({
      task: input.prompt,
      workspaceIndex,
      rankedContext,
      packageVersion,
      operationId,
      responseTokenBudget,
      recommendedContentTokenBudget:
        options.recommendedContentTokenBudget ??
        optimization?.recommendedContentTokenBudget ??
        assessment.tokenBudget,
      includeSummaries: assessment.mode === "context_pack_with_summaries",
      ...(optimization?.summaryMaxChars
        ? { summaryMaxChars: optimization.summaryMaxChars }
        : {}),
      ...(optimization?.fallbackLimit !== undefined
        ? { fallbackLimit: optimization.fallbackLimit }
        : {}),
    });
    abortController.signal.throwIfAborted();
    const additionalContext = renderHookContext(contextPack, assessment);
    const responseTokens = estimateTextTokens(additionalContext);

    if (responseTokens > responseTokenBudget) {
      throw new RangeError(
        `User-prompt hook context exceeded its ${responseTokenBudget}-token response budget.`,
      );
    }

    const fileByPath = new Map(
      workspaceIndex.files.map((file) => [file.path, file] as const),
    );
    const evidence = createEvidence({
      assessment,
      cacheEnabled,
      changedFiles: workspaceAnalysis.statistics.changedFiles,
      deletedFiles: workspaceAnalysis.statistics.deletedFiles,
      durationMs: elapsedMilliseconds(startedAt),
      generatedAt,
      operationId,
      outcome: "context_injected",
      packageVersion,
      previousWorkspaceAnalysisFound: previousWorkspaceAnalysis !== undefined,
      previousWorkspaceIndexFound: previousWorkspaceIndex !== undefined,
      responseTokenBudget,
      responseTokens,
      reusedFiles: workspaceAnalysis.statistics.reusedFiles,
      selectedFiles: contextPack.selected.map((candidate) => {
        const contentHash = fileByPath.get(candidate.path)?.contentHash;

        return {
          path: candidate.path,
          ...(contentHash ? { contentHash } : {}),
        };
      }),
      taskHash,
      workspaceRootHash: workspaceIdentity.rootHash,
    });

    if (store) {
      const workspaceAttribution = { workspaceRootHash: workspaceIdentity.rootHash };
      await store.set(
        STORE_KINDS.workspaceIndex,
        cacheKey,
        workspaceIndex,
        workspaceAttribution,
      );
      await store.set(
        STORE_KINDS.workspaceAnalysis,
        cacheKey,
        createPersistableWorkspaceAnalysis(workspaceAnalysis),
        workspaceAttribution,
      );
    }
    await persistHookEvidence({
      evidence,
      operationId,
      prompt: input.prompt,
      responseTokens,
      store,
      workspaceRootHash: workspaceIdentity.rootHash,
    });

    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      },
      evidence,
    };
  } finally {
    clearTimeout(timeout);
    await store?.close();
  }
}

function renderHookContext(contextPack: ContextPack, assessment: TaskAssessment): string {
  const lines = [
    "# Agent Token Optimizer Context",
    "Use this precomputed context before repository exploration. Read a selected file only when exact implementation detail is still required.",
    `Recommendation: ${assessment.mode}; complexity ${assessment.complexity}; risk ${assessment.risk}.`,
    "Selected files:",
    ...contextPack.selected.map(
      (candidate) => `- ${candidate.path}: ${candidate.reason}`,
    ),
  ];

  if (contextPack.summaries.length > 0) {
    lines.push("Focused summaries:");
    for (const summary of contextPack.summaries) {
      lines.push(`- ${summary.path}: ${summary.summary}`);
      if (summary.symbols.length > 0) {
        lines.push(`  Symbols: ${summary.symbols.join(", ")}`);
      }
      if (summary.testNames.length > 0) {
        lines.push(`  Tests: ${summary.testNames.join(", ")}`);
      }
      if (summary.snippet) {
        lines.push(`  Snippet: ${summary.snippet}`);
      }
    }
  }

  return redactText(lines.join("\n")).text;
}

function createPersistableWorkspaceAnalysis(
  analysis: WorkspaceAnalysisIndex,
): WorkspaceAnalysisIndex {
  return {
    ...analysis,
    files: analysis.files.map((file) => ({
      ...file,
      symbols: file.symbols.map((symbol) => {
        const name = redactText(symbol.name).text;

        return {
          ...symbol,
          name,
          signature: `${symbol.exported ? "exported " : ""}${symbol.kind} ${name}`,
        };
      }),
      imports: file.imports.map((value) => redactText(value).text),
      lexicalTerms: [],
      ownership: {
        ...file.ownership,
        ...(file.ownership.workspaceName
          ? { workspaceName: redactText(file.ownership.workspaceName).text }
          : {}),
        ...(file.ownership.packageName
          ? { packageName: redactText(file.ownership.packageName).text }
          : {}),
      },
    })),
    documentFrequencies: {},
  };
}

function createEvidence(input: {
  readonly assessment: TaskAssessment;
  readonly cacheEnabled: boolean;
  readonly changedFiles?: number;
  readonly deletedFiles?: number;
  readonly durationMs: number;
  readonly generatedAt: string;
  readonly operationId: string;
  readonly outcome: UserPromptHookEvidence["outcome"];
  readonly packageVersion: string;
  readonly previousWorkspaceAnalysisFound?: boolean;
  readonly previousWorkspaceIndexFound?: boolean;
  readonly responseTokenBudget: number;
  readonly responseTokens: number;
  readonly reusedFiles?: number;
  readonly selectedFiles: UserPromptHookEvidence["selectedFiles"];
  readonly taskHash: string;
  readonly workspaceRootHash: string;
}): UserPromptHookEvidence {
  return UserPromptHookEvidenceSchema.parse({
    metadata: {
      contractVersion: "1.0",
      generatedAt: input.generatedAt,
      generator: {
        name: "agent-token-optimizer",
        version: input.packageVersion,
      },
      operationId: input.operationId,
    },
    event: "UserPromptSubmit",
    taskHash: input.taskHash,
    workspaceRootHash: input.workspaceRootHash,
    outcome: input.outcome,
    recommendation: {
      mode: input.assessment.mode,
      complexity: input.assessment.complexity,
      risk: input.assessment.risk,
    },
    selectedFiles: input.selectedFiles,
    response: {
      budgetTokens: input.responseTokenBudget,
      usedTokens: input.responseTokens,
    },
    cache: {
      enabled: input.cacheEnabled,
      previousWorkspaceIndexFound: input.previousWorkspaceIndexFound ?? false,
      previousWorkspaceAnalysisFound: input.previousWorkspaceAnalysisFound ?? false,
      reusedFiles: input.reusedFiles ?? 0,
      changedFiles: input.changedFiles ?? 0,
      deletedFiles: input.deletedFiles ?? 0,
    },
    durationMs: input.durationMs,
  });
}

async function persistHookEvidence(input: {
  readonly evidence: UserPromptHookEvidence;
  readonly operationId: string;
  readonly prompt: string;
  readonly responseTokens?: number;
  readonly store: SqliteStore | undefined;
  readonly workspaceRootHash: string;
}): Promise<void> {
  if (!input.store) {
    return;
  }

  const requestTokens = estimateTextTokens(input.prompt);
  const responseTokens = input.responseTokens ?? 0;
  const metadata = input.evidence.metadata;
  const tokenLedger = mergeTokenLedger({
    metadata,
    runId: `user-prompt-hook:${input.operationId}`,
    taskId: input.evidence.taskHash,
    entries: [
      {
        entryId: `optimizer:${input.operationId}`,
        recordedAt: metadata.generatedAt,
        operationId: input.operationId,
        kind: "optimizer_call",
        status: "known",
        toolName: "user_prompt_hook",
        overhead: {
          requestTokens,
          responseTokens,
          totalTokens: requestTokens + responseTokens,
          method: "approximate",
          confidence: "medium",
        },
      },
    ],
  });

  const workspaceAttribution = { workspaceRootHash: input.workspaceRootHash };
  await input.store.set(
    STORE_KINDS.userPromptHookEvidence,
    input.operationId,
    input.evidence,
    workspaceAttribution,
  );
  await input.store.set(
    STORE_KINDS.tokenLedger,
    tokenLedger.runId,
    tokenLedger,
    workspaceAttribution,
  );
}

function assertResponseTokenBudget(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET
  ) {
    throw new TypeError(
      `User-prompt hook response budget must be between 1 and ${MAX_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET} tokens.`,
    );
  }
}

function assertTimeLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new TypeError(
      "User-prompt hook time limit must be between 1 and 30000 milliseconds.",
    );
  }
}

const MAX_PROMPT_LENGTH = 20_000;

function readPromptText(value: unknown): string {
  if (typeof value === "string") {
    return readBoundedString(value, "prompt", MAX_PROMPT_LENGTH);
  }

  if (Array.isArray(value)) {
    const textParts: string[] = [];

    for (const part of value) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        continue;
      }

      const record = part as Record<string, unknown>;

      if (record.type === "text" && typeof record.text === "string") {
        textParts.push(record.text);
      }
    }

    return readBoundedString(textParts.join("\n"), "prompt", MAX_PROMPT_LENGTH);
  }

  throw new TypeError(
    "User-prompt hook prompt must be a string or an array of content parts.",
  );
}

function readBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(
      `User-prompt hook ${name} must be a string up to ${maxLength} characters.`,
    );
  }

  return value;
}

function optionalBoundedString(
  value: unknown,
  name: "session_id" | "turn_id",
  maxLength: number,
): Partial<Pick<UserPromptHookInput, "session_id" | "turn_id">> {
  if (value === undefined) {
    return {};
  }

  return { [name]: readBoundedString(value, name, maxLength) };
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
