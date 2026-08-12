#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyDetectedHostInstallPlan,
  atomicWriteFile,
  createHostInstallPlan,
  createHostUninstallPlan,
  inspectHostAdapters,
  MANAGED_HOOK_MARKER,
  pathExists,
  parseSupportedHosts,
  type HostConfigChangeAction,
} from "@agent-relay/agent-token-optimization-host-adapters";
import {
  assessTask,
  analyzeWorkspace,
  buildContextPack,
  createContextRankingEvidence,
  createWorkspaceContentFingerprint,
  ContextRankingEvidenceSchema,
  createLogger,
  DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
  discoverWorkspace,
  FileSummarySchema,
  getWorkspaceIdentity,
  loadWorkspaceConfiguration,
  rankContext,
  runDoctor,
  STORE_KINDS,
  SqliteStore,
  type AgentTokenStore,
  type ContextCandidate,
  type FileSummary,
  type StoreRecordKind,
  type WorkspaceConfiguration,
} from "@agent-relay/agent-token-optimization-core";
import { runStdioServer } from "@agent-relay/agent-token-optimization-mcp-server";

import {
  DEFAULT_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET,
  MAX_USER_PROMPT_HOOK_INPUT_BYTES,
  parseUserPromptHookInput,
  runUserPromptHook,
} from "./user-prompt-hook";

const PACKAGE_VERSION = "0.1.0";
const DEFAULT_CACHE_PATH = path.join(
  os.homedir(),
  ".agent-token-optimizer",
  "cache.sqlite",
);

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly io: CliIo;
  readonly readStdin: () => Promise<string>;
}

interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

interface InitChangeRecord {
  readonly action: HostConfigChangeAction;
  readonly description: string;
  readonly path: string;
  readonly target: "cache" | "workspace-config";
}

export async function runCli(
  argv: readonly string[],
  environment: Partial<CliEnvironment> = {},
): Promise<number> {
  const cliEnvironment = createCliEnvironment(environment);
  const parsedArgs = parseArgs(argv);

  try {
    switch (parsedArgs.command) {
      case "":
      case "help":
      case "--help":
      case "-h":
        cliEnvironment.io.stdout(helpText());
        return 0;
      case "init":
        return await initCommand(parsedArgs, cliEnvironment);
      case "install":
        return await installCommand(parsedArgs, cliEnvironment);
      case "uninstall":
        return await uninstallCommand(parsedArgs, cliEnvironment);
      case "doctor":
        return await doctorCommand(parsedArgs, cliEnvironment);
      case "mcp":
        return await mcpCommand(parsedArgs, cliEnvironment);
      case "hook":
        return await hookCommand(parsedArgs, cliEnvironment);
      case "optimize":
        return await optimizeCommand(parsedArgs, cliEnvironment);
      case "cache":
        return await cacheCommand(parsedArgs, cliEnvironment);
      default:
        cliEnvironment.io.stderr(`Unknown command: ${parsedArgs.command}`);
        cliEnvironment.io.stderr("Run `agent-token-optimizer help` for usage.");
        return 2;
    }
  } catch (error) {
    cliEnvironment.io.stderr(formatError(error));
    return 1;
  }
}

async function initCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(initHelpText());
    return 0;
  }

  const workspaceRoot = resolveWorkspaceRoot(args, environment);
  const existingWorkspaceConfiguration = await loadWorkspaceConfiguration(workspaceRoot);
  const existingConfiguration = existingWorkspaceConfiguration.config;
  const cachePath = resolveCachePath(
    args,
    environment,
    workspaceRoot,
    existingConfiguration,
  );
  const configPath = existingWorkspaceConfiguration.configPath;
  const existingWithoutHostAdapters = {
    ...existingConfiguration,
    hostAdapters: undefined,
  };
  const config = {
    ...existingWithoutHostAdapters,
    version: 1,
    workspaceRoot,
    cachePath,
    cache: existingConfiguration?.cache ?? { enabled: true },
  };
  const serializedConfig = `${JSON.stringify(config, null, 2)}\n`;
  const plannedConfigChange = createInitChangeRecord({
    target: "workspace-config",
    path: configPath,
    description: "Write the managed workspace configuration.",
    existingContent: await readTextIfExists(configPath),
    content: serializedConfig,
  });
  const configChange =
    hasFlag(args, "force") && plannedConfigChange.action === "unchanged"
      ? { ...plannedConfigChange, action: "update" as const }
      : plannedConfigChange;
  const cacheChange: InitChangeRecord = {
    target: "cache",
    path: cachePath,
    description: "Initialize the local SQLite cache.",
    action: (await pathExists(cachePath)) ? "unchanged" : "create",
  };
  const plannedChanges = [configChange, cacheChange];

  if (!hasFlag(args, "dry-run")) {
    if (configChange.action !== "unchanged") {
      await atomicWriteFile(configPath, serializedConfig);
    }
    await withStore(cachePath, async (store) => {
      await store.health();
    });
  }
  const appliedChanges = hasFlag(args, "dry-run")
    ? []
    : [
        ...(configChange.action === "unchanged" ? [] : [configChange]),
        ...(cacheChange.action === "unchanged" ? [] : [cacheChange]),
      ];
  const unchangedChanges = plannedChanges.filter(
    (change) => change.action === "unchanged",
  );
  const status = hasFlag(args, "dry-run")
    ? "planned"
    : appliedChanges.length > 0
      ? "initialized"
      : "unchanged";

  return writeOutput(
    environment,
    args,
    {
      status,
      workspaceRoot,
      configPath,
      cachePath,
      changes: {
        planned: plannedChanges,
        applied: appliedChanges,
        unchanged: unchangedChanges,
      },
      next: "Run `agent-token-optimizer doctor` to verify local readiness.",
    },
    [
      `${hasFlag(args, "dry-run") ? "Would initialize" : status === "unchanged" ? "No changes needed for" : "Initialized"} Agent Token Optimizer.`,
      `Workspace: ${workspaceRoot}`,
      `Config: ${configPath}`,
      `Cache: ${cachePath}`,
      ...formatInitChanges(plannedChanges, appliedChanges),
    ],
  );
}

async function installCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(installHelpText());
    return 0;
  }

  const workspaceRoot = resolveWorkspaceRoot(args, environment);
  const requestedHosts = parseSupportedHosts(stringFlag(args, "hosts"));
  const context = {
    homePath: resolveHomePath(environment),
    workspaceRoot,
    hookCommand: createManagedHookCommand(args, environment),
    env: environment.env,
    ...(requestedHosts ? { requestedHosts } : {}),
  };
  const plan = await createHostInstallPlan(context);
  const applyResult = await applyDetectedHostInstallPlan(plan, {
    dryRun: hasFlag(args, "dry-run"),
  });
  const statuses = hasFlag(args, "dry-run") ? [] : await inspectHostAdapters(context);
  const status = hasFlag(args, "dry-run")
    ? "planned"
    : applyResult.applied.length > 0
      ? "installed"
      : "unchanged";
  const changes = plan.changes.map((change) => ({
    host: change.host,
    path: change.path,
    description: change.description,
    action: change.action,
    backupPath: applyResult.applied.find((applied) => applied.path === change.path)
      ?.backupPath,
  }));

  return writeOutput(
    environment,
    args,
    {
      status,
      changes,
      hosts: statuses,
      warnings: plan.warnings,
      trustReview:
        "Review the managed command in each host configuration before approving hook execution.",
    },
    [
      status === "planned"
        ? "Planned local hook installation."
        : status === "unchanged"
          ? "Local hooks are already up to date."
          : "Installed local hooks.",
      ...changes.map((change) => `- [${change.action}] ${change.host}: ${change.path}`),
      ...plan.warnings,
      "Review the managed command in each host configuration before approving hook execution.",
    ],
  );
}

async function uninstallCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(uninstallHelpText());
    return 0;
  }

  const workspaceRoot = resolveWorkspaceRoot(args, environment);
  const requestedHosts = parseSupportedHosts(stringFlag(args, "hosts"));
  const context = {
    homePath: resolveHomePath(environment),
    workspaceRoot,
    hookCommand: createManagedHookCommand(args, environment),
    env: environment.env,
    ...(requestedHosts ? { requestedHosts } : {}),
  };
  const plan = await createHostUninstallPlan(context);
  const applyResult = await applyDetectedHostInstallPlan(plan, {
    dryRun: hasFlag(args, "dry-run"),
  });
  const status = hasFlag(args, "dry-run")
    ? "planned"
    : applyResult.applied.length > 0
      ? "uninstalled"
      : "not-installed";
  const changes = plan.changes.map((change) => ({
    host: change.host,
    path: change.path,
    description: change.description,
    action: change.action,
    backupPath: applyResult.applied.find((applied) => applied.path === change.path)
      ?.backupPath,
  }));

  return writeOutput(environment, args, { status, changes, warnings: plan.warnings }, [
    status === "planned"
      ? "Planned local hook removal."
      : status === "uninstalled"
        ? "Removed managed local hooks."
        : "No managed local hooks were installed.",
    ...changes.map((change) => `- [${change.action}] ${change.host}: ${change.path}`),
    ...plan.warnings,
  ]);
}

async function doctorCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(doctorHelpText());
    return 0;
  }

  const workspaceRoot = resolveWorkspaceRoot(args, environment);
  const workspaceConfiguration = await loadWorkspaceConfiguration(workspaceRoot);
  const cachePath = resolveCachePath(
    args,
    environment,
    workspaceRoot,
    workspaceConfiguration.config,
  );
  const diagnostic = await withStore(cachePath, (store) =>
    runDoctor({
      packageVersion: PACKAGE_VERSION,
      workspacePath: workspaceRoot,
      store,
    }),
  );
  const requestedHosts = parseSupportedHosts(stringFlag(args, "hosts"));
  const hostStatuses = await inspectHostAdapters({
    homePath: resolveHomePath(environment),
    workspaceRoot,
    hookCommand: createManagedHookCommand(args, environment),
    ...(requestedHosts ? { requestedHosts } : {}),
  });
  const hostFailure = hostStatuses.some(
    (host) => host.status === "invalid" || host.status === "version-mismatch",
  );
  const requestedHostMissing =
    requestedHosts !== undefined &&
    hostStatuses.some((host) => host.status === "not-installed");
  const status =
    diagnostic.status === "fail" || hostFailure || requestedHostMissing
      ? "fail"
      : diagnostic.status;

  writeOutput(environment, args, { ...diagnostic, status, hosts: hostStatuses }, [
    `Status: ${status}`,
    ...diagnostic.checks.map(
      (check) => `${check.status}: ${check.name} - ${check.message}`,
    ),
    ...hostStatuses.map(
      (host) => `${host.status}: ${host.displayName} - ${host.message}`,
    ),
  ]);

  return status === "fail" ? 1 : 0;
}

async function mcpCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(mcpHelpText());
    return 0;
  }

  await runStdioServer({
    packageVersion: PACKAGE_VERSION,
    workspaceRoot: resolveWorkspaceRoot(args, environment),
    cachePath: resolveCachePath(args, environment),
    logger: createLogger({
      component: "cli-mcp",
    }),
  });

  return 0;
}

async function hookCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(hookHelpText());
    return 0;
  }

  const action = args.positionals[0];

  if (action !== "user-prompt") {
    environment.io.stderr(`Unknown hook action: ${action ?? "(missing)"}`);
    environment.io.stderr(hookHelpText());
    return 2;
  }

  const hookHost = stringFlag(args, "host");

  if (hookHost !== undefined && hookHost !== "kimi") {
    environment.io.stderr(
      `Unknown hook host: ${hookHost}. Context injection was skipped.`,
    );
    return 0;
  }

  try {
    const input = parseUserPromptHookInput(await environment.readStdin());
    const workspaceRoot = path.resolve(input.cwd);
    const workspaceConfiguration = await loadWorkspaceConfiguration(workspaceRoot);
    const configuration = workspaceConfiguration.config;
    const recommendedContentTokenBudget =
      numberFlag(args, "content-budget") ??
      configuration?.optimization?.recommendedContentTokenBudget;
    const result = await runUserPromptHook(input, {
      cachePath: resolveHookCachePath(args, environment),
      cacheEnabled: configuration?.cache?.enabled ?? true,
      packageVersion: PACKAGE_VERSION,
      responseTokenBudget:
        numberFlag(args, "response-budget") ??
        configuration?.optimization?.responseTokenBudget ??
        DEFAULT_USER_PROMPT_HOOK_RESPONSE_TOKEN_BUDGET,
      ...(recommendedContentTokenBudget !== undefined
        ? { recommendedContentTokenBudget }
        : {}),
      ...(configuration?.optimization
        ? { optimization: configuration.optimization }
        : {}),
    });

    if (result.output) {
      environment.io.stdout(
        hookHost === "kimi"
          ? result.output.hookSpecificOutput.additionalContext
          : JSON.stringify(result.output),
      );
    }

    return 0;
  } catch {
    // Kimi Code appends raw stdout to the turn context on exit 0, so failures
    // must stay silent there; JSON hosts receive an explicit skip message.
    if (hookHost !== "kimi") {
      environment.io.stdout(
        JSON.stringify({
          continue: true,
          systemMessage:
            "Agent Token Optimizer skipped context injection because local hook processing failed.",
        }),
      );
    }
    return 0;
  }
}

async function optimizeCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(optimizeHelpText());
    return 0;
  }

  const task = readTask(args);
  const workspaceRoot = resolveWorkspaceRoot(args, environment);
  const workspaceConfiguration = await loadWorkspaceConfiguration(workspaceRoot);
  const configuration = workspaceConfiguration.config;
  const optimization = configuration?.optimization;
  const cachePath = resolveCachePath(args, environment, workspaceRoot, configuration);
  const cacheEnabled = hasFlag(args, "cache") && (configuration?.cache?.enabled ?? true);
  const maxFiles = numberFlag(args, "max-files") ?? optimization?.maxFiles;
  const maxTotalBytes =
    numberFlag(args, "max-total-bytes") ?? optimization?.maxTotalBytes;
  const concurrency = numberFlag(args, "concurrency") ?? optimization?.concurrency;
  const workspaceIdentity = cacheEnabled
    ? await getWorkspaceIdentity(workspaceRoot)
    : undefined;
  const previousWorkspaceIndex = workspaceIdentity
    ? await withStore(
        cachePath,
        async (store) =>
          await store.get(
            STORE_KINDS.workspaceIndex,
            `${workspaceIdentity.rootHash}:latest`,
          ),
      )
    : undefined;
  const workspaceIndex = await discoverWorkspace({
    rootPath: workspaceRoot,
    packageVersion: PACKAGE_VERSION,
    includeContentHashes: true,
    ...(optimization?.maxFileSizeBytes
      ? { maxFileSizeBytes: optimization.maxFileSizeBytes }
      : {}),
    ...(maxFiles !== undefined ? { maxFiles } : {}),
    ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(optimization?.extraIgnorePatterns
      ? { extraIgnorePatterns: optimization.extraIgnorePatterns }
      : {}),
    ...(optimization?.supportedLanguages
      ? { supportedLanguages: optimization.supportedLanguages }
      : {}),
    ...(previousWorkspaceIndex ? { previousIndex: previousWorkspaceIndex } : {}),
  });
  const previousWorkspaceAnalysis = cacheEnabled
    ? await withStore(
        cachePath,
        async (store) =>
          await store.get(
            STORE_KINDS.workspaceAnalysis,
            `${workspaceIndex.workspace.rootHash}:latest`,
          ),
      )
    : undefined;
  const workspaceAnalysis = await analyzeWorkspace({
    workspaceIndex,
    packageVersion: PACKAGE_VERSION,
    ...(previousWorkspaceAnalysis ? { previousIndex: previousWorkspaceAnalysis } : {}),
  });
  const rankingLimit = numberFlag(args, "limit") ?? optimization?.rankingLimit;
  const responseTokenBudget =
    numberFlag(args, "response-budget") ?? optimization?.responseTokenBudget;
  const recommendedContentTokenBudget =
    numberFlag(args, "content-budget") ?? optimization?.recommendedContentTokenBudget;
  const modelHint = stringFlag(args, "model");
  const summaryMaxChars =
    optimization?.summaryMaxChars ?? DEFAULT_CONTEXT_SUMMARY_MAX_CHARS;
  const selectionThreshold = optimization?.selectionThreshold;
  const fallbackLimit = optimization?.fallbackLimit;
  const rankingCacheKey = createRankingCacheKey(workspaceIndex, task, {
    ...(rankingLimit ? { rankingLimit } : {}),
    ...(selectionThreshold !== undefined ? { selectionThreshold } : {}),
  });
  const cachedRanking = cacheEnabled
    ? await withStore(cachePath, async (store) => {
        const ranking = await store.get(STORE_KINDS.contextRanking, rankingCacheKey);
        return ranking ? ContextRankingEvidenceSchema.parse(ranking) : undefined;
      })
    : undefined;
  const rankedContext = cachedRanking
    ? { selected: cachedRanking.selected, excluded: cachedRanking.excluded }
    : rankContext({
        task,
        workspaceIndex,
        workspaceAnalysis,
        taskHints: assessTask({
          task,
          workspaceIndex,
          workspaceAnalysis,
        }).hints,
        ...(rankingLimit ? { limit: rankingLimit } : {}),
        ...(selectionThreshold !== undefined ? { selectionThreshold } : {}),
      });
  const cachedSummaries = cacheEnabled
    ? await loadCachedSummaries(
        cachePath,
        workspaceIndex.workspace.rootHash,
        task,
        summaryMaxChars,
        rankedContext.selected,
      )
    : undefined;
  const contextPack = await buildContextPack({
    task,
    workspaceIndex,
    rankedContext,
    packageVersion: PACKAGE_VERSION,
    includeSummaries: !hasFlag(args, "no-summaries"),
    ...(cachedSummaries ? { cachedSummaries } : {}),
    summaryMaxChars,
    ...(fallbackLimit !== undefined ? { fallbackLimit } : {}),
    ...(responseTokenBudget ? { responseTokenBudget } : {}),
    ...(recommendedContentTokenBudget ? { recommendedContentTokenBudget } : {}),
    ...(modelHint ? { modelHint } : {}),
  });

  if (cacheEnabled) {
    const rankingEvidence = createContextRankingEvidence({
      contextPack,
      rankedContext,
      workspaceIndex,
    });
    const workspaceRootHash = workspaceIndex.workspace.rootHash;
    const workspaceAttribution = { workspaceRootHash };
    await withStore(cachePath, async (store) => {
      await store.set(
        STORE_KINDS.workspaceIndex,
        `${workspaceRootHash}:latest`,
        workspaceIndex,
        workspaceAttribution,
      );
      if (workspaceAnalysis) {
        await store.set(
          STORE_KINDS.workspaceAnalysis,
          `${workspaceRootHash}:latest`,
          workspaceAnalysis,
          workspaceAttribution,
        );
      }
      await store.set(
        STORE_KINDS.contextPack,
        contextPack.packId ??
          contextPack.metadata.operationId ??
          `context-pack:${Date.now()}`,
        contextPack,
        workspaceAttribution,
      );
      await store.set(
        STORE_KINDS.contextRanking,
        rankingEvidence.packId,
        rankingEvidence,
        workspaceAttribution,
      );
      await store.set(STORE_KINDS.contextRanking, rankingCacheKey, rankingEvidence, {
        workspaceRootHash,
      });
      for (const summary of contextPack.summaries) {
        await store.set(
          STORE_KINDS.fileSummary,
          createSummaryCacheKey(workspaceRootHash, task, summaryMaxChars, summary.path),
          summary,
          {
            workspaceRootHash,
            ...(summary.contentHash ? { contentHash: summary.contentHash } : {}),
          },
        );
      }
    });
  }

  return writeOutput(environment, args, contextPack, [
    `Selected ${contextPack.selected.length} files for task context.`,
    `Estimated response tokens: ${contextPack.tokenEstimate?.totalTokens ?? "unknown"}`,
    `Recommended content tokens: ${contextPack.budget?.recommendedContent.usedTokens ?? "unknown"}`,
    "",
    ...contextPack.selected.map(
      (candidate) => `${candidate.rank}. ${candidate.path} - ${candidate.reason}`,
    ),
  ]);
}

async function cacheCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  if (hasHelp(args)) {
    environment.io.stdout(cacheHelpText());
    return 0;
  }

  const action = args.positionals[0] ?? "status";
  const cachePath = resolveCachePath(args, environment);

  switch (action) {
    case "status":
      return await withStore(cachePath, async (store) => {
        const health = await store.health();
        return writeOutput(environment, args, health, [
          `Cache: ${health.databasePath}`,
          `Records: ${health.records}`,
          `Migrations: ${health.migrationsApplied.join(", ")}`,
        ]);
      });
    case "list":
      return await withStore(cachePath, async (store) => {
        const kind = parseStoreKind(args.positionals[1]);

        if (kind) {
          const records = await store.list(kind);

          return writeOutput(
            environment,
            args,
            {
              cachePath,
              kind,
              records: records.map((record) => ({
                key: record.key,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
              })),
            },
            [
              `Cache: ${cachePath}`,
              `Records of kind ${kind}: ${records.length}`,
              ...records.map((record) => `- ${record.key} (updated ${record.updatedAt})`),
            ],
          );
        }

        const kinds = await Promise.all(
          Object.values(STORE_KINDS).map(async (storeKind) => ({
            kind: storeKind,
            records: (await store.list(storeKind)).length,
          })),
        );
        const total = kinds.reduce((sum, entry) => sum + entry.records, 0);

        return writeOutput(environment, args, { cachePath, total, kinds }, [
          `Cache: ${cachePath}`,
          `Records: ${total}`,
          ...kinds
            .filter((entry) => entry.records > 0)
            .map((entry) => `- ${entry.kind}: ${entry.records}`),
        ]);
      });
    case "clear":
      return await withStore(cachePath, async (store) => {
        const kind = parseStoreKind(args.positionals[1]);
        const cleared = await store.clear(kind);
        return writeOutput(environment, args, { cachePath, cleared, kind }, [
          `Cleared ${cleared} cache records${kind ? ` of kind ${kind}` : ""}.`,
        ]);
      });
    case "evict": {
      const workspace = await getWorkspaceIdentity(
        resolveWorkspaceRoot(args, environment),
      );

      return await withStore(cachePath, async (store) => {
        const result = await store.deleteByWorkspace(workspace.rootHash);

        return writeOutput(
          environment,
          args,
          {
            cachePath,
            workspaceRoot: workspace.rootPath,
            workspaceRootHash: workspace.rootHash,
            evicted: result.evicted,
            evictedByKind: result.evictedByKind,
          },
          [
            `Evicted ${result.evicted} cache records for workspace ${workspace.rootPath}.`,
            ...Object.entries(result.evictedByKind).map(
              ([entryKind, count]) => `- ${entryKind}: ${count}`,
            ),
          ],
        );
      });
    }
    case "repair":
      return await repairCacheCommand(cachePath, args, environment);
    default:
      environment.io.stderr(`Unknown cache action: ${action}`);
      environment.io.stderr(cacheHelpText());
      return 2;
  }
}

function createCliEnvironment(environment: Partial<CliEnvironment>): CliEnvironment {
  return {
    cwd: environment.cwd ?? process.cwd(),
    env: environment.env ?? process.env,
    io: environment.io ?? {
      stdout(message) {
        console.log(message);
      },
      stderr(message) {
        console.error(message);
      },
    },
    readStdin: environment.readStdin ?? readProcessStdin,
  };
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_USER_PROMPT_HOOK_INPUT_BYTES) {
      throw new TypeError("User-prompt hook input exceeds the 1 MiB safety limit.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (!value) {
      continue;
    }

    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split("=", 2);

    if (!rawKey) {
      continue;
    }

    if (inlineValue !== undefined) {
      flags.set(rawKey, inlineValue);
      continue;
    }

    const nextValue = rest[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      flags.set(rawKey, nextValue);
      index += 1;
      continue;
    }

    flags.set(rawKey, true);
  }

  return {
    command,
    positionals,
    flags,
  };
}

function resolveWorkspaceRoot(args: ParsedArgs, environment: CliEnvironment): string {
  return path.resolve(stringFlag(args, "workspace") ?? environment.cwd);
}

function resolveCachePath(
  args: ParsedArgs,
  environment: CliEnvironment,
  workspaceRoot?: string,
  configuration?: WorkspaceConfiguration,
): string {
  const configuredCachePath = configuration?.cachePath
    ? path.resolve(workspaceRoot ?? environment.cwd, configuration.cachePath)
    : undefined;

  return path.resolve(
    stringFlag(args, "cache-path") ??
      configuredCachePath ??
      environment.env.AGENT_TOKEN_OPTIMIZER_CACHE_PATH ??
      DEFAULT_CACHE_PATH,
  );
}

function resolveHookCachePath(args: ParsedArgs, environment: CliEnvironment): string {
  return path.resolve(
    stringFlag(args, "cache-path") ??
      environment.env.AGENT_TOKEN_OPTIMIZER_CACHE_PATH ??
      DEFAULT_CACHE_PATH,
  );
}

function createLocalCliCommand(action: string): string[] {
  return [process.execPath, fileURLToPath(import.meta.url), action];
}

function createManagedHookCommand(
  args: ParsedArgs,
  environment: CliEnvironment,
): string[] {
  return [
    ...createLocalCliCommand("hook"),
    "user-prompt",
    "--managed-by",
    MANAGED_HOOK_MARKER,
    "--cache-path",
    resolveHookCachePath(args, environment),
  ];
}

function resolveHomePath(environment: CliEnvironment): string {
  return path.resolve(environment.env.HOME ?? os.homedir());
}

function readTask(args: ParsedArgs): string {
  const task = stringFlag(args, "task") ?? args.positionals.join(" ");

  if (!task.trim()) {
    throw new Error('Missing task. Pass --task "..." or provide a positional task.');
  }

  return task.trim();
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

async function loadCachedSummaries(
  cachePath: string,
  workspaceRootHash: string,
  task: string,
  summaryMaxChars: number,
  candidates: readonly ContextCandidate[],
): Promise<Map<string, FileSummary>> {
  return await withStore(cachePath, async (store) => {
    const summaries = await Promise.all(
      candidates.map(async (candidate) => {
        const summary = await store.get(
          STORE_KINDS.fileSummary,
          createSummaryCacheKey(workspaceRootHash, task, summaryMaxChars, candidate.path),
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

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function repairCacheCommand(
  cachePath: string,
  args: ParsedArgs,
  environment: CliEnvironment,
): Promise<number> {
  const store = new SqliteStore({ databasePath: cachePath });

  try {
    await store.repair();
    const health = await store.health();

    return writeOutput(environment, args, health, [
      `Repaired cache: ${health.databasePath}`,
      `Records: ${health.records}`,
    ]);
  } finally {
    await store.close();
  }
}

function writeOutput(
  environment: CliEnvironment,
  args: ParsedArgs,
  jsonValue: unknown,
  textLines: readonly string[],
  exitCode = 0,
): number {
  environment.io.stdout(
    hasFlag(args, "json") ? JSON.stringify(jsonValue, null, 2) : textLines.join("\n"),
  );

  return exitCode;
}

function parseStoreKind(value: string | undefined): StoreRecordKind | undefined {
  if (!value) {
    return undefined;
  }

  const kinds = Object.values(STORE_KINDS);

  if (kinds.includes(value as StoreRecordKind)) {
    return value as StoreRecordKind;
  }

  throw new Error(`Unknown cache record kind: ${value}`);
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags.get(name);

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Flag --${name} must be a positive integer.`);
  }

  return parsed;
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);

  return typeof value === "string" ? value : undefined;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function hasHelp(args: ParsedArgs): boolean {
  return hasFlag(args, "help");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

function helpText(): string {
  return [
    "Agent Token Optimizer",
    "",
    "Usage:",
    "  agent-token-optimizer <command> [options]",
    "",
    "Commands:",
    "  install    Install local hooks for supported coding agents",
    "  doctor     Check optimizer and hook readiness",
    "  uninstall  Remove managed hooks without touching user hooks",
    "  init       Initialize optional workspace config and cache",
    "  mcp        Run the MCP server over stdio",
    "  hook       Run a host lifecycle hook handler",
    "  optimize   Build a context pack for a task",
    "  cache      Inspect, list, clear, evict, or repair local cache",
    "",
    "Global options:",
    "  --workspace <path>   Workspace root, defaults to current directory",
    "  --cache-path <path>  Local cache database path",
    "  --json               Emit JSON output",
  ].join("\n");
}

function initHelpText(): string {
  return [
    "Usage: agent-token-optimizer init [--workspace <path>] [--cache-path <path>] [--force] [--json]",
    "",
    "Initializes optional workspace tuning config and verifies cache creation.",
  ].join("\n");
}

function installHelpText(): string {
  return [
    "Usage: agent-token-optimizer install [--hosts codex,claude-code,kimi] [--cache-path <path>] [--dry-run] [--json]",
    "",
    "Installs a managed local UserPromptSubmit hook while preserving existing user hooks.",
  ].join("\n");
}

function uninstallHelpText(): string {
  return [
    "Usage: agent-token-optimizer uninstall [--hosts codex,claude-code,kimi] [--cache-path <path>] [--dry-run] [--json]",
    "",
    "Removes only the managed Agent Token Optimizer hook entries.",
  ].join("\n");
}

function doctorHelpText(): string {
  return "Usage: agent-token-optimizer doctor [--workspace <path>] [--hosts codex,claude-code,kimi] [--cache-path <path>] [--json]";
}

function mcpHelpText(): string {
  return "Usage: agent-token-optimizer mcp [--cache-path <path>]";
}

function hookHelpText(): string {
  return [
    "Usage: agent-token-optimizer hook user-prompt [--host kimi] [--cache-path <path>] [--response-budget <tokens>] [--content-budget <tokens>]",
    "",
    "Reads one Codex, Claude Code, or Kimi Code UserPromptSubmit event and emits bounded additional context.",
    "With --host kimi the context is emitted as plain text because Kimi Code appends hook stdout to the turn context.",
  ].join("\n");
}

function optimizeHelpText(): string {
  return [
    "Usage: agent-token-optimizer optimize --task <task> [--workspace <path>] [--limit <n>] [--max-files <n>] [--max-total-bytes <bytes>] [--concurrency <n>] [--response-budget <tokens>] [--content-budget <tokens>] [--model <name>] [--cache] [--json]",
    "",
    "Builds a context pack using workspace discovery, ranking, summaries, and token estimates.",
  ].join("\n");
}

function cacheHelpText(): string {
  return [
    "Usage: agent-token-optimizer cache [status|list|clear|evict|repair] [kind] [--cache-path <path>] [--json]",
    "",
    "Actions:",
    "  status   Show cache path, record count, and applied migrations",
    "  list     Show record counts per kind, or record keys for one kind",
    "  clear    Remove all records, or all records of one kind",
    "  evict    Remove records attributed to one workspace (--workspace, defaults to the current directory)",
    "  repair   Recreate the cache database in place",
    "",
    `Kinds: ${Object.values(STORE_KINDS).join(", ")}`,
  ].join("\n");
}

const isDirectExecution = isDirectCliExecution(process.argv[1]);

if (isDirectExecution) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

function isDirectCliExecution(entrypointPath: string | undefined): boolean {
  if (entrypointPath === undefined) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);

  try {
    return realpathSync(modulePath) === realpathSync(entrypointPath);
  } catch {
    return path.resolve(modulePath) === path.resolve(entrypointPath);
  }
}

function createInitChangeRecord(input: {
  readonly target: InitChangeRecord["target"];
  readonly path: string;
  readonly description: string;
  readonly existingContent: string | undefined;
  readonly content: string;
}): InitChangeRecord {
  return {
    target: input.target,
    path: input.path,
    description: input.description,
    action:
      input.existingContent === undefined
        ? "create"
        : input.existingContent === input.content
          ? "unchanged"
          : "update",
  };
}

async function readTextIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ENOENT") {
        return undefined;
      }
    }

    throw error;
  }
}

function formatInitChanges(
  plannedChanges: readonly InitChangeRecord[],
  appliedChanges: readonly InitChangeRecord[],
): string[] {
  const changesToReport = appliedChanges.length > 0 ? appliedChanges : plannedChanges;

  return changesToReport.map(
    (change) => `- [${change.action}] ${change.target}: ${change.path}`,
  );
}
