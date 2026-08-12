import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  AgentTokenError,
  assessTask,
  analyzeWorkspace,
  buildContextPack,
  buildStructuralSummary,
  createContextRankingEvidence,
  createWorkspaceContentFingerprint,
  createLocalObservabilityCounters,
  DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
  createLogger,
  getWorkspaceIdentity,
  loadWorkspaceConfiguration,
  createWorkspacePathPolicy,
  discoverWorkspace,
  estimateSerializedTokens,
  estimateTextTokens,
  expandContextRanking,
  mergeTokenLedger,
  rankContext,
  redactText,
  runDoctor,
  STORE_KINDS,
  SqliteStore,
  TaskAnalysisSchema,
  ContextRankingEvidenceSchema,
  FileSummarySchema,
  RunMetricSchema,
  WorkspaceAnalysisIndexSchema,
  WorkspaceIndexSchema,
  withOperationTimeout,
  type AgentTokenStore,
  type ContextCandidate,
  type ContractMetadata,
  type ContextPack,
  type ContextRankingEvidence,
  type FileSummary,
  type Logger,
  type LocalObservabilityCounters,
  type TaskAnalysis,
  type TokenEstimate,
  type TokenLedgerEntry,
  type Warning,
  type WorkspaceAnalysisIndex,
  type WorkspaceConfiguration,
} from "@agent-relay/agent-token-optimization-core";

import type {
  AnalyzeTaskInput,
  BuildContextPackInput,
  EstimateTokensInput,
  ExpandContextInput,
  HealthInput,
  RecordRunInput,
  SummarizeTargetsInput,
} from "./schemas";
import { createMcpSecurityPolicy, type McpSecurityPolicyOptions } from "./security";

const DEFAULT_PACKAGE_VERSION = "0.1.0";
const MAX_IN_MEMORY_RANKINGS = 100;

export interface ToolHandlerOptions {
  readonly packageVersion?: string;
  readonly logger?: Logger;
  readonly workspaceRoot?: string;
  readonly cachePath?: string;
  readonly security?: McpSecurityPolicyOptions;
  readonly now?: () => Date;
  readonly observabilityCounters?: LocalObservabilityCounters;
}

export interface AgentTokenOptimizerToolHandlers {
  readonly analyzeTask: (input: AnalyzeTaskInput) => Promise<CallToolResult>;
  readonly buildContextPack: (input: BuildContextPackInput) => Promise<CallToolResult>;
  readonly expandContext: (input: ExpandContextInput) => Promise<CallToolResult>;
  readonly estimateTokens: (input: EstimateTokensInput) => Promise<CallToolResult>;
  readonly summarizeTargets: (input: SummarizeTargetsInput) => Promise<CallToolResult>;
  readonly recordRun: (input: RecordRunInput) => Promise<CallToolResult>;
  readonly health: (input: HealthInput) => Promise<CallToolResult>;
}

export function createToolHandlers(
  options: ToolHandlerOptions = {},
): AgentTokenOptimizerToolHandlers {
  const logger =
    options.logger ??
    createLogger({
      component: "mcp-server",
    });
  const packageVersion = options.packageVersion ?? DEFAULT_PACKAGE_VERSION;
  const now = options.now ?? (() => new Date());
  const securityPolicy = createMcpSecurityPolicy(options.security);
  const observabilityCounters =
    options.observabilityCounters ?? createLocalObservabilityCounters();
  const rankingEvidenceByPackId = new Map<string, ContextRankingEvidence>();

  return {
    analyzeTask(input) {
      return runTool({
        logger,
        event: "analyze_task",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId, signal) => {
          securityPolicy.validateAnalyzeTask(input);
          const workspaceRoot = await resolveRequestWorkspaceRoot(
            input.workspaceRoot,
            options,
          );
          const workspaceConfiguration = workspaceRoot
            ? await loadWorkspaceConfiguration(workspaceRoot)
            : undefined;
          const configuration = workspaceConfiguration?.config;
          const cachePath = resolveCachePath(input.cachePath, options, configuration);
          const optimization = configuration?.optimization;
          const workspaceIdentity = workspaceRoot
            ? await getWorkspaceIdentity(workspaceRoot)
            : undefined;
          const previousWorkspaceIndex =
            workspaceIdentity && cachePath
              ? await loadWorkspaceIndex(cachePath, workspaceIdentity.rootHash)
              : undefined;
          const workspaceIndex = workspaceRoot
            ? await discoverWorkspace({
                rootPath: workspaceRoot,
                packageVersion,
                operationId,
                ...(optimization?.maxFileSizeBytes
                  ? {
                      maxFileSizeBytes: Math.min(
                        optimization.maxFileSizeBytes,
                        securityPolicy.limits.maxWorkspaceFileSizeBytes,
                      ),
                    }
                  : {}),
                ...(optimization?.maxFiles
                  ? {
                      maxFiles: Math.min(
                        optimization.maxFiles,
                        securityPolicy.limits.maxWorkspaceFiles,
                      ),
                    }
                  : {}),
                ...(optimization?.maxTotalBytes !== undefined
                  ? {
                      maxTotalBytes: Math.min(
                        optimization.maxTotalBytes,
                        securityPolicy.limits.maxWorkspaceTotalBytes,
                      ),
                    }
                  : {}),
                ...(optimization?.concurrency
                  ? {
                      concurrency: Math.min(
                        optimization.concurrency,
                        securityPolicy.limits.maxWorkspaceConcurrency,
                      ),
                    }
                  : {}),
                ...(optimization?.extraIgnorePatterns
                  ? { extraIgnorePatterns: optimization.extraIgnorePatterns }
                  : {}),
                ...(optimization?.supportedLanguages
                  ? { supportedLanguages: optimization.supportedLanguages }
                  : {}),
                ...(previousWorkspaceIndex
                  ? { previousIndex: previousWorkspaceIndex }
                  : {}),
                signal,
              })
            : undefined;
          const previousWorkspaceAnalysis =
            workspaceIndex && cachePath
              ? await loadWorkspaceAnalysis(cachePath, workspaceIndex.workspace.rootHash)
              : undefined;
          const workspaceAnalysis = workspaceIndex
            ? await analyzeWorkspace({
                workspaceIndex,
                packageVersion,
                operationId,
                ...(previousWorkspaceAnalysis
                  ? { previousIndex: previousWorkspaceAnalysis }
                  : {}),
                now: now(),
              })
            : undefined;
          const analysis = createTaskAnalysis(
            input.task,
            packageVersion,
            operationId,
            now(),
            workspaceIndex,
            workspaceAnalysis,
          );

          return jsonResult({ operationId, analysis });
        },
      });
    },
    buildContextPack(input) {
      return runTool({
        logger,
        event: "build_context_pack",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId, signal) => {
          securityPolicy.validateBuildContextPack(input);
          const workspaceRoot = await resolveRequiredWorkspaceRoot(
            input.workspaceRoot,
            options,
          );
          const workspaceConfiguration = await loadWorkspaceConfiguration(workspaceRoot);
          const configuration = workspaceConfiguration.config;
          const optimization = configuration?.optimization;
          const cachePath = resolveCachePath(input.cachePath, options, configuration);
          const workspaceIdentity = await getWorkspaceIdentity(workspaceRoot);
          const previousWorkspaceIndex = cachePath
            ? await loadWorkspaceIndex(cachePath, workspaceIdentity.rootHash)
            : undefined;
          const workspaceIndex = await discoverWorkspace({
            rootPath: workspaceRoot,
            packageVersion,
            operationId,
            ...(previousWorkspaceIndex ? { previousIndex: previousWorkspaceIndex } : {}),
            maxFileSizeBytes: Math.min(
              input.maxFileSizeBytes ??
                optimization?.maxFileSizeBytes ??
                securityPolicy.limits.maxWorkspaceFileSizeBytes,
              securityPolicy.limits.maxWorkspaceFileSizeBytes,
            ),
            maxFiles: Math.min(
              input.maxFiles ??
                optimization?.maxFiles ??
                securityPolicy.limits.maxWorkspaceFiles,
              securityPolicy.limits.maxWorkspaceFiles,
            ),
            maxTotalBytes: Math.min(
              input.maxTotalBytes ??
                optimization?.maxTotalBytes ??
                securityPolicy.limits.maxWorkspaceTotalBytes,
              securityPolicy.limits.maxWorkspaceTotalBytes,
            ),
            concurrency: Math.min(
              input.concurrency ??
                optimization?.concurrency ??
                securityPolicy.limits.maxWorkspaceConcurrency,
              securityPolicy.limits.maxWorkspaceConcurrency,
            ),
            extraIgnorePatterns: [
              ...(optimization?.extraIgnorePatterns ?? []),
              ...input.extraIgnorePatterns,
            ],
            ...(optimization?.supportedLanguages
              ? { supportedLanguages: optimization.supportedLanguages }
              : {}),
            signal,
          });
          const previousWorkspaceAnalysis = cachePath
            ? await loadWorkspaceAnalysis(cachePath, workspaceIndex.workspace.rootHash)
            : undefined;
          const workspaceAnalysis = await analyzeWorkspace({
            workspaceIndex,
            packageVersion,
            operationId,
            ...(previousWorkspaceAnalysis
              ? { previousIndex: previousWorkspaceAnalysis }
              : {}),
            now: now(),
          });
          const taskAnalysis = createTaskAnalysis(
            input.task,
            packageVersion,
            operationId,
            now(),
            workspaceIndex,
            workspaceAnalysis,
          );
          const rankingLimit = input.rankingLimit ?? optimization?.rankingLimit;
          const selectionThreshold =
            input.selectionThreshold ?? optimization?.selectionThreshold;
          const fallbackLimit = input.fallbackLimit ?? optimization?.fallbackLimit;
          const responseTokenBudget =
            input.responseTokenBudget ?? optimization?.responseTokenBudget;
          const recommendedContentTokenBudget =
            input.recommendedContentTokenBudget ??
            optimization?.recommendedContentTokenBudget;
          const summaryMaxChars =
            input.summaryMaxChars ??
            optimization?.summaryMaxChars ??
            DEFAULT_CONTEXT_SUMMARY_MAX_CHARS;
          const rankingCacheKey = createRankingCacheKey(workspaceIndex, input.task, {
            ...(rankingLimit ? { rankingLimit } : {}),
            ...(selectionThreshold !== undefined ? { selectionThreshold } : {}),
            recentlyChangedPaths: input.recentlyChangedPaths,
          });
          const cachedRanking = cachePath
            ? await loadCachedRanking(cachePath, rankingCacheKey)
            : undefined;
          const rankedContext = cachedRanking
            ? {
                selected: cachedRanking.selected,
                excluded: cachedRanking.excluded,
              }
            : rankContext({
                task: input.task,
                workspaceIndex,
                workspaceAnalysis,
                ...(taskAnalysis.task.hints
                  ? { taskHints: taskAnalysis.task.hints }
                  : {}),
                ...(rankingLimit ? { limit: rankingLimit } : {}),
                ...(input.recentlyChangedPaths.length > 0
                  ? { recentlyChangedPaths: input.recentlyChangedPaths }
                  : {}),
                ...(selectionThreshold !== undefined ? { selectionThreshold } : {}),
                now: now(),
              });
          const cachedSummaries = cachePath
            ? await loadCachedSummaries({
                cachePath,
                workspaceRootHash: workspaceIndex.workspace.rootHash,
                task: input.task,
                summaryMaxChars,
                candidates: rankedContext.selected,
              })
            : undefined;
          const contextPack = await buildContextPack({
            task: input.task,
            workspaceIndex,
            rankedContext,
            packageVersion,
            operationId,
            taskAnalysis,
            ...(cachedSummaries ? { cachedSummaries } : {}),
            ...(input.modelHint ? { modelHint: input.modelHint } : {}),
            summaryMaxChars,
            ...(fallbackLimit !== undefined ? { fallbackLimit } : {}),
            ...(responseTokenBudget !== undefined ? { responseTokenBudget } : {}),
            ...(recommendedContentTokenBudget !== undefined
              ? {
                  recommendedContentTokenBudget,
                }
              : {}),
            includeSummaries: input.includeSummaries,
            now: now(),
          });
          const rankingEvidence = createContextRankingEvidence({
            contextPack,
            rankedContext,
            workspaceIndex,
          });
          rememberRankingEvidence(rankingEvidenceByPackId, rankingEvidence);
          const persisted = await persistContextPack({
            workspaceIndex,
            workspaceAnalysis,
            contextPack,
            rankingEvidence,
            rankingCacheKey,
            task: input.task,
            summaryMaxChars,
            ...(cachePath ? { cachePath } : {}),
          });

          return jsonResult({
            operationId,
            contextPack,
            workspaceTotals: workspaceIndex.totals,
            persisted,
          });
        },
      });
    },
    expandContext(input) {
      return runTool({
        logger,
        event: "expand_context",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId) => {
          securityPolicy.validateExpandContext(input);
          observabilityCounters.increment("expansionRequested");
          const rankingEvidence = await loadRankingEvidence({
            packId: input.packId,
            evidenceByPackId: rankingEvidenceByPackId,
            ...optionalString("cachePath", resolveCachePath(input.cachePath, options)),
          });

          if (!rankingEvidence) {
            return jsonResult({
              operationId,
              warnings: [
                {
                  code: "expansion_evidence_unavailable",
                  message:
                    "Context expansion evidence is unavailable; rebuild the context pack before expanding it.",
                  severity: "warn",
                  recoverable: true,
                },
              ],
            });
          }

          const page = expandContextRanking({
            evidence: rankingEvidence,
            cursor: input.cursor,
            limit: input.limit,
          });

          return jsonResult({ operationId, page, warnings: [] });
        },
      });
    },
    estimateTokens(input) {
      return runTool({
        logger,
        event: "estimate_tokens",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: (operationId) => {
          securityPolicy.validateEstimateTokens(input);
          const tokenEstimate = estimateTokens(input);

          return jsonResult({ operationId, tokenEstimate });
        },
      });
    },
    summarizeTargets(input) {
      return runTool({
        logger,
        event: "summarize_targets",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId) => {
          securityPolicy.validateSummarizeTargets(input);
          const workspaceRoot = await resolveRequiredWorkspaceRoot(
            input.workspaceRoot,
            options,
          );
          const { summaries, warnings } = await summarizeTargets(
            { ...input, workspaceRoot },
            {
              maxFileSizeBytes: securityPolicy.limits.maxSummaryTargetFileSizeBytes,
              packageVersion,
              operationId,
            },
          );

          return jsonResult({ operationId, summaries, warnings });
        },
      });
    },
    recordRun(input) {
      return runTool({
        logger,
        event: "record_run",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId) => {
          securityPolicy.validateRecordRun(input);
          if (input.workflow?.contextPackAccepted) {
            observabilityCounters.increment("contextPackAccepted");
          }
          if (input.workflow?.fallbackScanPerformed) {
            observabilityCounters.increment("fallbackScanPerformed");
          }
          if (input.validation) {
            observabilityCounters.increment(
              input.validation.passed ? "validationPassed" : "validationFailed",
            );
          }
          const generatedAt = now().toISOString();
          const warnings = [...input.warnings];
          const runMetric = RunMetricSchema.parse({
            metadata: createMetadata(packageVersion, operationId, generatedAt),
            host: input.host,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.taskId ? { taskId: input.taskId } : {}),
            startedAt: input.startedAt ?? generatedAt,
            ...(input.completedAt ? { completedAt: input.completedAt } : {}),
            ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
            outcome: input.outcome,
            ...(input.tokenEstimate ? { tokenEstimate: input.tokenEstimate } : {}),
            ...(input.tokenAccounting ? { tokenAccounting: input.tokenAccounting } : {}),
            ...(input.validation ? { validation: input.validation } : {}),
            warnings,
          });
          const cachePath = resolveCachePath(input.cachePath, options);
          // Attribute run records to the server's canonical configured workspace
          // (never caller-controlled input) so `cache evict --workspace` removes
          // them. Absent a configured workspace they are legitimately global.
          const runAttribution = await resolveConfiguredWorkspaceAttribution(options);
          const ledgerEntries = input.runId
            ? createTokenLedgerEntries(input, operationId, generatedAt)
            : [];
          let tokenLedger = input.runId
            ? mergeTokenLedger({
                metadata: createMetadata(packageVersion, operationId, generatedAt),
                runId: input.runId,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                entries: ledgerEntries,
              })
            : undefined;
          const persisted = cachePath
            ? await withStore(cachePath, async (store) => {
                await store.set(
                  STORE_KINDS.runMetric,
                  operationId,
                  runMetric,
                  runAttribution,
                );

                if (input.runId) {
                  const existing = await store.get(STORE_KINDS.tokenLedger, input.runId);
                  tokenLedger = mergeTokenLedger({
                    metadata: createMetadata(packageVersion, operationId, generatedAt),
                    runId: input.runId,
                    ...(input.taskId ? { taskId: input.taskId } : {}),
                    ...(existing ? { existing } : {}),
                    entries: ledgerEntries,
                  });
                  await store.set(
                    STORE_KINDS.tokenLedger,
                    input.runId,
                    tokenLedger,
                    runAttribution,
                  );
                }

                return true;
              })
            : false;

          if (!persisted) {
            warnings.push({
              code: "cache_not_configured",
              message:
                "Run metric and optional token ledger were validated but not persisted because no cache path was configured.",
              severity: "warn",
              recoverable: true,
            });
          }

          return jsonResult({
            operationId,
            runMetric,
            ...(tokenLedger ? { tokenLedger } : {}),
            persisted,
            warnings,
          });
        },
      });
    },
    health(input) {
      return runTool({
        logger,
        event: "health",
        operationId: randomUUID(),
        timeoutMs: securityPolicy.limits.operationTimeoutMs,
        action: async (operationId) => {
          securityPolicy.validateHealth(input);
          const workspaceRoot = await resolveRequestWorkspaceRoot(
            input.workspaceRoot,
            options,
          );
          const workspaceConfiguration = workspaceRoot
            ? await loadWorkspaceConfiguration(workspaceRoot)
            : undefined;
          const cachePath = resolveCachePath(
            input.cachePath,
            options,
            workspaceConfiguration?.config,
          );
          const diagnostic = cachePath
            ? await withStore(cachePath, (store) =>
                runDoctor({
                  packageVersion,
                  operationId,
                  store,
                  now: now(),
                  ...optionalString("workspacePath", workspaceRoot),
                }),
              )
            : await runDoctor({
                packageVersion,
                operationId,
                now: now(),
                ...optionalString("workspacePath", workspaceRoot),
              });

          return jsonResult({
            operationId,
            diagnostic,
            observability: observabilityCounters.snapshot(),
          });
        },
      });
    },
  };
}

function createTaskAnalysis(
  taskInput: string,
  packageVersion: string,
  operationId: string,
  generatedAt: Date,
  workspaceIndex?: Awaited<ReturnType<typeof discoverWorkspace>>,
  workspaceAnalysis?: WorkspaceAnalysisIndex,
): TaskAnalysis {
  const task = taskInput.trim();
  const assessment = assessTask({
    task,
    ...(workspaceIndex ? { workspaceIndex } : {}),
    ...(workspaceAnalysis ? { workspaceAnalysis } : {}),
  });

  return TaskAnalysisSchema.parse({
    metadata: createMetadata(packageVersion, operationId, generatedAt.toISOString()),
    task: {
      description: task,
      complexity: assessment.complexity,
      risk: assessment.risk,
      hints: assessment.hints,
    },
    recommendation: {
      mode: assessment.mode,
      reason: assessment.reason,
      tokenBudget: assessment.tokenBudget,
    },
    warnings: [],
  });
}

function estimateTokens(input: EstimateTokensInput): TokenEstimate {
  if (input.contextPack) {
    const inputTokens = estimateSerializedTokens(input.contextPack);

    return {
      ...(input.modelHint ? { modelHint: input.modelHint } : {}),
      inputTokens,
      totalTokens: inputTokens,
      method: "approximate",
      confidence: "medium",
    };
  }

  const inputTokens = estimateTextTokens(input.text ?? "");

  return {
    ...(input.modelHint ? { modelHint: input.modelHint } : {}),
    inputTokens,
    totalTokens: inputTokens,
    method: "approximate",
    confidence: "medium",
  };
}

function createTokenLedgerEntries(
  input: RecordRunInput,
  operationId: string,
  generatedAt: string,
): TokenLedgerEntry[] {
  const optimizerEntries: TokenLedgerEntry[] = input.optimizerCalls.map((call) =>
    call.status === "known"
      ? {
          entryId: `optimizer:${call.operationId}`,
          recordedAt: call.recordedAt ?? generatedAt,
          operationId: call.operationId,
          kind: "optimizer_call",
          status: "known",
          toolName: call.toolName,
          overhead: call.overhead,
        }
      : {
          entryId: `optimizer:${call.operationId}`,
          recordedAt: call.recordedAt ?? generatedAt,
          operationId: call.operationId,
          kind: "optimizer_call",
          status: "unknown",
          toolName: call.toolName,
          unknownReason: call.unknownReason,
        },
  );
  const agentEntry: TokenLedgerEntry = input.tokenAccounting
    ? {
        entryId: `agent:${operationId}`,
        recordedAt: input.completedAt ?? generatedAt,
        operationId,
        kind: "agent_run",
        status: "known",
        accounting: input.tokenAccounting,
      }
    : {
        entryId: `agent:${operationId}`,
        recordedAt: input.completedAt ?? generatedAt,
        operationId,
        kind: "agent_run",
        status: "unknown",
        unknownReason: "Agent workflow token usage was not reported.",
      };

  return [...optimizerEntries, agentEntry];
}

async function summarizeTargets(
  input: SummarizeTargetsInput,
  options: {
    readonly maxFileSizeBytes: number;
    readonly packageVersion: string;
    readonly operationId: string;
  },
): Promise<{
  summaries: FileSummary[];
  warnings: Warning[];
}> {
  const pathPolicy = await createWorkspacePathPolicy(input.workspaceRoot);
  const workspaceIndex = await discoverWorkspace({
    rootPath: input.workspaceRoot,
    packageVersion: options.packageVersion,
    operationId: options.operationId,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const workspaceFileByPath = new Map(
    workspaceIndex.files.map((file) => [file.path, file] as const),
  );
  const warnings: Warning[] = [];
  const selectedPaths: string[] = [];

  for (const target of input.targets) {
    const absoluteTarget = pathPolicy.resolveWorkspacePath(target);
    const targetStat = await stat(absoluteTarget);

    if (targetStat.isDirectory()) {
      const normalizedTarget = target.replace(/\/+$/u, "");
      for (const file of workspaceIndex.files) {
        if (selectedPaths.length >= input.maxFiles) {
          break;
        }

        if (
          !file.ignored &&
          file.kind !== "binary" &&
          file.kind !== "generated" &&
          (normalizedTarget === "." || file.path.startsWith(`${normalizedTarget}/`))
        ) {
          selectedPaths.push(file.path);
        }
      }
      continue;
    }

    if (targetStat.isFile()) {
      const workspaceFile = workspaceFileByPath.get(target);

      if (!workspaceFile) {
        warnings.push(createSummaryWarning("summary_file_unindexed", target));
        continue;
      }

      if (workspaceFile.ignored) {
        if (workspaceFile.ignoreReason === "oversized") {
          warnings.push(
            createSummaryWarning(
              "summary_target_oversized",
              target,
              "Skipped target because it exceeds the summary file size limit.",
            ),
          );
          continue;
        }

        warnings.push(
          createSummaryWarning(
            "summary_target_ignored",
            target,
            "Skipped target because it is ignored by workspace policy.",
          ),
        );
        continue;
      }

      if (workspaceFile.kind === "binary" || workspaceFile.kind === "generated") {
        warnings.push(
          createSummaryWarning(
            "summary_target_unsupported",
            target,
            "Skipped target because it is binary or generated.",
          ),
        );
        continue;
      }

      selectedPaths.push(target);
    }
  }

  const summaries: FileSummary[] = [];

  for (const relativePath of selectedPaths.slice(0, input.maxFiles)) {
    const absoluteFile = pathPolicy.resolveWorkspacePath(relativePath);
    const fileStat = await stat(absoluteFile);
    const workspaceFile = workspaceFileByPath.get(relativePath);

    if (!workspaceFile) {
      warnings.push(createSummaryWarning("summary_file_unindexed", relativePath));
      continue;
    }

    if (fileStat.size > options.maxFileSizeBytes) {
      warnings.push(
        createSummaryWarning(
          "summary_target_oversized",
          relativePath,
          "Skipped target because it exceeds the summary file size limit.",
        ),
      );
      continue;
    }

    try {
      const content = await readFile(absoluteFile, "utf8");
      const redacted = redactText(content);
      summaries.push({
        path: relativePath,
        contentHash: hashText(content),
        ...buildStructuralSummary({
          content: redacted.text,
          file: workspaceFile,
          ...(input.task ? { task: input.task } : {}),
          maxChars: input.maxChars,
        }),
        warnings: [],
        redactions: redacted.redactions,
      });
    } catch {
      warnings.push({
        code: "summary_read_failed",
        message: "Skipped target because it could not be read as text.",
        severity: "warn",
        path: relativePath,
        recoverable: true,
      });
    }
  }

  if (selectedPaths.length > input.maxFiles) {
    warnings.push({
      code: "summary_target_limit_reached",
      message: "Some targets were skipped because the max file limit was reached.",
      severity: "warn",
      recoverable: true,
    });
  }

  return { summaries, warnings };
}

async function persistContextPack(input: {
  readonly cachePath?: string;
  readonly workspaceIndex: Awaited<ReturnType<typeof discoverWorkspace>>;
  readonly workspaceAnalysis: WorkspaceAnalysisIndex;
  readonly contextPack: ContextPack;
  readonly rankingEvidence: ContextRankingEvidence;
  readonly rankingCacheKey: string;
  readonly task: string;
  readonly summaryMaxChars: number;
}): Promise<boolean> {
  if (!input.cachePath) {
    return false;
  }

  const workspaceRootHash = input.workspaceIndex.workspace.rootHash;
  const workspaceAttribution = { workspaceRootHash };
  await withStore(input.cachePath, async (store) => {
    await store.set(
      STORE_KINDS.workspaceIndex,
      `${workspaceRootHash}:latest`,
      input.workspaceIndex,
      workspaceAttribution,
    );
    await store.set(
      STORE_KINDS.workspaceAnalysis,
      `${workspaceRootHash}:latest`,
      input.workspaceAnalysis,
      workspaceAttribution,
    );
    await store.set(
      STORE_KINDS.contextPack,
      input.contextPack.packId ?? input.contextPack.metadata.operationId ?? randomUUID(),
      input.contextPack,
      workspaceAttribution,
    );
    await store.set(
      STORE_KINDS.contextRanking,
      input.rankingEvidence.packId,
      input.rankingEvidence,
      workspaceAttribution,
    );
    await store.set(
      STORE_KINDS.contextRanking,
      input.rankingCacheKey,
      input.rankingEvidence,
      workspaceAttribution,
    );
    for (const summary of input.contextPack.summaries) {
      await store.set(
        STORE_KINDS.fileSummary,
        createSummaryCacheKey(
          workspaceRootHash,
          input.task,
          input.summaryMaxChars,
          summary.path,
        ),
        summary,
        {
          workspaceRootHash,
          ...(summary.contentHash ? { contentHash: summary.contentHash } : {}),
        },
      );
    }

    if (input.contextPack.tokenEstimate) {
      await store.set(
        STORE_KINDS.tokenEstimate,
        input.contextPack.metadata.operationId ?? randomUUID(),
        input.contextPack.tokenEstimate,
        workspaceAttribution,
      );
    }
  });

  return true;
}

async function loadWorkspaceAnalysis(
  cachePath: string,
  workspaceRootHash: string,
): Promise<WorkspaceAnalysisIndex | undefined> {
  return withStore(cachePath, async (store) => {
    const storedAnalysis = await store.get(
      STORE_KINDS.workspaceAnalysis,
      `${workspaceRootHash}:latest`,
    );

    return storedAnalysis
      ? WorkspaceAnalysisIndexSchema.parse(storedAnalysis)
      : undefined;
  });
}

async function loadWorkspaceIndex(
  cachePath: string,
  workspaceRootHash: string,
): Promise<Awaited<ReturnType<typeof discoverWorkspace>> | undefined> {
  return withStore(cachePath, async (store) => {
    const storedIndex = await store.get(
      STORE_KINDS.workspaceIndex,
      `${workspaceRootHash}:latest`,
    );

    return storedIndex ? WorkspaceIndexSchema.parse(storedIndex) : undefined;
  });
}

async function loadCachedRanking(
  cachePath: string,
  rankingCacheKey: string,
): Promise<ContextRankingEvidence | undefined> {
  return withStore(cachePath, async (store) => {
    const storedRanking = await store.get(STORE_KINDS.contextRanking, rankingCacheKey);

    return storedRanking ? ContextRankingEvidenceSchema.parse(storedRanking) : undefined;
  });
}

async function loadCachedSummaries(input: {
  readonly cachePath: string;
  readonly workspaceRootHash: string;
  readonly task: string;
  readonly summaryMaxChars: number;
  readonly candidates: readonly ContextCandidate[];
}): Promise<Map<string, FileSummary>> {
  return withStore(input.cachePath, async (store) => {
    const summaries = await Promise.all(
      input.candidates.map(async (candidate) => {
        const summary = await store.get(
          STORE_KINDS.fileSummary,
          createSummaryCacheKey(
            input.workspaceRootHash,
            input.task,
            input.summaryMaxChars,
            candidate.path,
          ),
        );

        return summary ? FileSummarySchema.parse(summary) : undefined;
      }),
    );

    return new Map(
      summaries
        .filter((summary): summary is FileSummary => summary !== undefined)
        .map((summary) => [summary.path, summary] as const),
    );
  });
}

function createRankingCacheKey(
  workspaceIndex: Awaited<ReturnType<typeof discoverWorkspace>>,
  task: string,
  options: {
    readonly rankingLimit?: number;
    readonly selectionThreshold?: number;
    readonly recentlyChangedPaths: readonly string[];
  },
): string {
  return `ranking:${workspaceIndex.workspace.rootHash}:${createWorkspaceContentFingerprint(workspaceIndex)}:${hashText(JSON.stringify({ task, options }))}`;
}

function createSummaryCacheKey(
  workspaceRootHash: string,
  task: string,
  summaryMaxChars: number,
  relativePath: string,
): string {
  return `summary:${workspaceRootHash}:${hashText(`${task}\0${summaryMaxChars}`)}:${relativePath}`;
}

async function loadRankingEvidence(input: {
  readonly packId: string;
  readonly cachePath?: string;
  readonly evidenceByPackId: ReadonlyMap<string, ContextRankingEvidence>;
}): Promise<ContextRankingEvidence | undefined> {
  const inMemoryEvidence = input.evidenceByPackId.get(input.packId);

  if (inMemoryEvidence) {
    return inMemoryEvidence;
  }

  if (!input.cachePath) {
    return undefined;
  }

  return withStore(input.cachePath, async (store) => {
    const storedEvidence = await store.get(STORE_KINDS.contextRanking, input.packId);
    return storedEvidence
      ? ContextRankingEvidenceSchema.parse(storedEvidence)
      : undefined;
  });
}

function rememberRankingEvidence(
  evidenceByPackId: Map<string, ContextRankingEvidence>,
  evidence: ContextRankingEvidence,
): void {
  evidenceByPackId.set(evidence.packId, evidence);

  while (evidenceByPackId.size > MAX_IN_MEMORY_RANKINGS) {
    const oldestPackId = evidenceByPackId.keys().next().value;
    if (!oldestPackId) {
      break;
    }
    evidenceByPackId.delete(oldestPackId);
  }
}

async function withStore<TResult>(
  cachePath: string,
  action: (store: AgentTokenStore) => Promise<TResult>,
): Promise<TResult> {
  const store = new SqliteStore({ databasePath: cachePath });
  await store.initialize();

  try {
    return await action(store);
  } finally {
    await store.close();
  }
}

async function runTool(input: {
  readonly logger: Logger;
  readonly event: string;
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly action: (
    operationId: string,
    signal: AbortSignal,
  ) => CallToolResult | Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const startedAt = Date.now();
  const toolLogger = input.logger.child({ operationId: input.operationId });
  const abortController = new AbortController();
  await toolLogger.info(`${input.event}.started`);

  try {
    const result = await withOperationTimeout(
      Promise.resolve(input.action(input.operationId, abortController.signal)),
      input.timeoutMs,
      input.event,
      () => abortController.abort(),
    );
    await toolLogger.info(`${input.event}.completed`, {
      elapsedMs: Date.now() - startedAt,
    });

    return result;
  } catch (error) {
    await toolLogger.error(`${input.event}.failed`, error, {
      elapsedMs: Date.now() - startedAt,
    });

    throw error;
  }
}

async function resolveConfiguredWorkspaceAttribution(
  options: ToolHandlerOptions,
): Promise<{ readonly workspaceRootHash: string } | undefined> {
  if (!options.workspaceRoot) {
    return undefined;
  }

  try {
    const identity = await getWorkspaceIdentity(options.workspaceRoot);
    return { workspaceRootHash: identity.rootHash };
  } catch {
    // A misconfigured workspace root should not fail run recording; the records
    // stay unattributed rather than being wrongly assigned.
    return undefined;
  }
}

function resolveCachePath(
  inputCachePath: string | undefined,
  options: ToolHandlerOptions,
  configuration?: WorkspaceConfiguration,
): string | undefined {
  if (configuration?.cache?.enabled === false) {
    return undefined;
  }

  const configuredCachePath = options.cachePath
    ? path.resolve(options.cachePath)
    : undefined;

  if (
    inputCachePath &&
    (!configuredCachePath || path.resolve(inputCachePath) !== configuredCachePath)
  ) {
    throw new AgentTokenError(
      "invalid_input",
      "The MCP request cannot select a cache path.",
      true,
      "Start the MCP server with --cache-path and omit cachePath from tool arguments.",
    );
  }

  return configuredCachePath;
}

async function resolveRequiredWorkspaceRoot(
  requestedRoot: string,
  options: ToolHandlerOptions,
): Promise<string> {
  const workspaceRoot = await resolveRequestWorkspaceRoot(requestedRoot, options);

  if (!workspaceRoot) {
    throw new AgentTokenError(
      "invalid_input",
      "A workspace root is required for this operation.",
      true,
    );
  }

  return workspaceRoot;
}

async function resolveRequestWorkspaceRoot(
  requestedRoot: string | undefined,
  options: ToolHandlerOptions,
): Promise<string | undefined> {
  if (!requestedRoot) {
    return undefined;
  }

  const allowedRoot = await realpath(
    path.resolve(options.workspaceRoot ?? process.cwd()),
  );
  const resolvedRoot = await realpath(path.resolve(requestedRoot));
  const relative = path.relative(allowedRoot, resolvedRoot);

  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new AgentTokenError(
      "invalid_input",
      "The requested workspace is outside the MCP server boundary.",
      true,
      "Restart the MCP server from the intended workspace instead of passing another root.",
    );
  }

  return resolvedRoot;
}

function jsonResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function createMetadata(
  packageVersion: string,
  operationId: string,
  generatedAt: string,
): ContractMetadata {
  return {
    contractVersion: "1.0",
    generatedAt,
    generator: {
      name: "agent-token-optimizer",
      version: packageVersion,
    },
    operationId,
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSummaryWarning(
  code: string,
  targetPath: string,
  message = "Skipped target because it is not part of the workspace index.",
): Warning {
  return {
    code,
    message,
    severity: "warn",
    path: targetPath,
    recoverable: true,
  };
}

function optionalString<TKey extends "cachePath" | "workspacePath">(
  key: TKey,
  value: string | undefined,
): Record<TKey, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<TKey, string>) : {};
}
