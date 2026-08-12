import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  STORE_KINDS,
  MemoryLogSink,
  SqliteStore,
  createLogger,
  getWorkspaceIdentity,
} from "@agent-relay/agent-token-optimization-core";

import { createAgentTokenOptimizerMcpServer } from "./server";

const temporaryRoots: string[] = [];

describe("agent token optimizer MCP server", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((temporaryRoot) =>
        rm(temporaryRoot, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("registers the expected MCP tools", async () => {
    const connection = await connectTestClient();

    try {
      const tools = await connection.client.listTools();

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "analyze_task",
        "build_context_pack",
        "estimate_tokens",
        "expand_context",
        "health",
        "record_run",
        "summarize_targets",
      ]);
    } finally {
      await connection.close();
    }
  });

  it("builds a context pack through the MCP protocol", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "billing.ts"),
      "export function chargeCustomer() { return true; }\n",
    );
    await writeFile(
      path.join(workspaceRoot, "src", "billing.test.ts"),
      "import { chargeCustomer } from './billing';\n",
    );
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update billing charge customer behavior and related tests",
          workspaceRoot,
          includeSummaries: true,
          responseTokenBudget: 1_500,
          recommendedContentTokenBudget: 100,
        },
      });

      expect(result.isError).not.toBe(true);
      const structuredContent = getStructuredContent(result);
      expect(structuredContent.persisted).toBe(false);
      expect(structuredContent.workspaceTotals.filesIndexed).toBe(2);
      expect(structuredContent.contextPack.budget).toMatchObject({
        response: { limitTokens: 1_500 },
        recommendedContent: { limitTokens: 100 },
      });
      expect(
        structuredContent.contextPack.budget.response.usedTokens,
      ).toBeLessThanOrEqual(1_500);
      expect(
        structuredContent.contextPack.selected.map((candidate) => candidate.path),
      ).toEqual(expect.arrayContaining(["src/billing.ts"]));
      expect(connection.logSink.events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          "build_context_pack.started",
          "build_context_pack.completed",
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it("applies workspace configuration while allowing MCP request overrides", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "optimizer.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "billing.ts"),
      "export function chargeCustomer() { return true; }\n",
    );
    await writeFile(
      path.join(workspaceRoot, "src", "legacy.ts"),
      "export const legacyCharge = true;\n",
    );
    await writeFile(path.join(workspaceRoot, "script.py"), "print('ignore me')\n");
    await writeWorkspaceConfig(workspaceRoot, {
      cachePath,
      cache: { enabled: true },
      optimization: {
        rankingLimit: 1,
        responseTokenBudget: 900,
        recommendedContentTokenBudget: 300,
        extraIgnorePatterns: ["src/legacy.ts"],
        supportedLanguages: ["typescript"],
      },
    });
    const connection = await connectTestClient({ cachePath });

    try {
      const result = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update billing charge behavior",
          workspaceRoot,
          includeSummaries: true,
          responseTokenBudget: 1_500,
        },
      });
      const structuredContent = getStructuredContent(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.persisted).toBe(true);
      expect(structuredContent.workspaceTotals.filesIndexed).toBe(1);
      expect(structuredContent.contextPack.budget).toMatchObject({
        response: { limitTokens: 1_500 },
        recommendedContent: { limitTokens: 300 },
      });
      const store = new SqliteStore({ databasePath: cachePath });
      await store.initialize();
      try {
        await expect(store.list(STORE_KINDS.workspaceIndex)).resolves.toHaveLength(1);
      } finally {
        await store.close();
      }
    } finally {
      await connection.close();
    }
  });

  it("does not persist when workspace configuration disables the cache", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "disabled.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "feature.ts"),
      "export const feature = true;\n",
    );
    await writeWorkspaceConfig(workspaceRoot, {
      cachePath,
      cache: { enabled: false },
    });
    const connection = await connectTestClient({ cachePath });

    try {
      const result = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update feature behavior",
          workspaceRoot,
          cachePath,
        },
      });
      const structuredContent = getStructuredContent(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.persisted).toBe(false);
      await expect(stat(cachePath)).rejects.toThrow();
    } finally {
      await connection.close();
    }
  });

  it("expands compact fallback candidates from persisted ranking evidence", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, "ranking.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writeFile(
          path.join(workspaceRoot, "src", `feature-${index + 1}.ts`),
          `export const feature${index + 1} = true;\n`,
        ),
      ),
    );
    const buildConnection = await connectTestClient({ cachePath });
    let packId = "";
    let cursor = "";

    try {
      const result = await buildConnection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update feature behavior and tests",
          workspaceRoot,
          cachePath,
          includeSummaries: false,
          rankingLimit: 2,
          fallbackLimit: 2,
        },
      });
      const structuredContent = getExpandableContextPack(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.persisted).toBe(true);
      expect(structuredContent.contextPack.selected).toHaveLength(2);
      expect(structuredContent.contextPack.excluded).toHaveLength(2);
      expect(
        structuredContent.contextPack.selected.every((item) => item.signals.length === 0),
      ).toBe(true);
      expect(
        structuredContent.contextPack.excluded.every((item) => item.signals.length === 0),
      ).toBe(true);
      expect(structuredContent.contextPack.omittedCandidateCount).toBe(6);
      packId = structuredContent.contextPack.packId;
      cursor = structuredContent.contextPack.expansion.nextCursor;

      const store = new SqliteStore({ databasePath: cachePath });
      await store.initialize();
      try {
        const evidence = await store.get(STORE_KINDS.contextRanking, packId);
        expect(evidence?.excluded).toHaveLength(8);
        expect(evidence?.excluded[0]?.signals.length).toBeGreaterThan(0);
        expect(evidence?.selected[0]?.signals.map((signal) => signal.name)).toContain(
          "bm25",
        );
        const workspaceAnalyses = await store.list(STORE_KINDS.workspaceAnalysis);
        expect(workspaceAnalyses).toHaveLength(1);
        expect(workspaceAnalyses[0]?.value.statistics.analyzedFiles).toBeGreaterThan(0);
      } finally {
        await store.close();
      }
    } finally {
      await buildConnection.close();
    }

    const expansionConnection = await connectTestClient({ cachePath });
    try {
      const result = await expansionConnection.client.callTool({
        name: "expand_context",
        arguments: {
          packId,
          cursor,
          limit: 3,
          cachePath,
        },
      });
      const structuredContent = getExpansionPage(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.warnings).toEqual([]);
      expect(structuredContent.page.candidates).toHaveLength(3);
      expect(
        structuredContent.page.candidates.every((item) => item.signals.length === 0),
      ).toBe(true);
      expect(structuredContent.page).toMatchObject({
        packId,
        hasMore: true,
        remainingCandidateCount: 3,
      });
    } finally {
      await expansionConnection.close();
    }
  });

  it("reuses cached workspace summaries and rankings for an unchanged task", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, "cache.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "feature.ts"),
      "export function updateFeature(): boolean { return true; }\n",
    );
    const connection = await connectTestClient({ cachePath });

    try {
      const initialResult = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update feature behavior",
          workspaceRoot,
          cachePath,
        },
      });
      expect(initialResult.isError).not.toBe(true);

      const store = new SqliteStore({ databasePath: cachePath });
      await store.initialize();
      try {
        const summaryRecord = (await store.list(STORE_KINDS.fileSummary))[0];
        expect(summaryRecord).toBeDefined();
        if (!summaryRecord) {
          throw new Error("Expected a cached summary.");
        }
        await store.set(STORE_KINDS.fileSummary, summaryRecord.key, {
          ...summaryRecord.value,
          summary: "Structural outline: reused cached summary.",
        });
      } finally {
        await store.close();
      }

      const warmResult = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update feature behavior",
          workspaceRoot,
          cachePath,
        },
      });
      const structuredContent = getStructuredContent(warmResult);

      expect(warmResult.isError).not.toBe(true);
      expect(structuredContent.contextPack.summaries[0]?.summary).toBe(
        "Structural outline: reused cached summary.",
      );

      const reopenedStore = new SqliteStore({ databasePath: cachePath });
      await reopenedStore.initialize();
      try {
        const analyses = await reopenedStore.list(STORE_KINDS.workspaceAnalysis);
        expect(analyses[0]?.value.statistics.reusedFiles).toBe(
          analyses[0]?.value.files.length,
        );
      } finally {
        await reopenedStore.close();
      }
    } finally {
      await connection.close();
    }
  });

  it("returns a recoverable warning when expansion evidence is unavailable", async () => {
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "expand_context",
        arguments: {
          packId: "missing-pack",
          cursor: "missing-cursor",
        },
      });
      const structuredContent = (
        isObject(result) ? result.structuredContent : undefined
      ) as {
        readonly page?: unknown;
        readonly warnings: readonly { readonly code: string }[];
      };

      expect(result.isError).not.toBe(true);
      expect(structuredContent.page).toBeUndefined();
      expect(structuredContent.warnings).toEqual([
        expect.objectContaining({ code: "expansion_evidence_unavailable" }),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("rejects invalid tool input at the MCP boundary", async () => {
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "analyze_task",
        arguments: {
          task: "",
        },
      });

      expect(result.isError).toBe(true);
      expect(getContent(result)[0]).toEqual(
        expect.objectContaining({
          type: "text",
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("uses supplied workspace evidence when analyzing task scope", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await mkdir(path.join(workspaceRoot, "src", "auth"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "auth", "session.ts"),
      "export function createSession(): boolean { return true; }\n",
    );
    await writeFile(
      path.join(workspaceRoot, "src", "auth", "session.test.ts"),
      "import { createSession } from './session';\n",
    );
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "analyze_task",
        arguments: {
          task: "Fix createSession in src/auth/session.ts",
          workspaceRoot,
        },
      });
      const structuredContent = (
        isObject(result) ? result.structuredContent : undefined
      ) as {
        readonly analysis: {
          readonly task: {
            readonly risk: string;
            readonly hints: {
              readonly paths: readonly string[];
              readonly symbols: readonly string[];
            };
          };
          readonly recommendation: { readonly mode: string };
        };
      };

      expect(result.isError).not.toBe(true);
      expect(structuredContent.analysis.task.hints.paths).toContain(
        "src/auth/session.ts",
      );
      expect(structuredContent.analysis.task.hints.symbols).toContain("createSession");
      expect(structuredContent.analysis.task.risk).toBe("high");
      expect(structuredContent.analysis.recommendation.mode).toBe(
        "context_pack_with_summaries",
      );
    } finally {
      await connection.close();
    }
  });

  it("records run metrics when a cache path is provided", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "ato.sqlite");
    const connection = await connectTestClient({ cachePath });

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          cachePath,
          host: "codex",
          outcome: "succeeded",
          durationMs: 1200,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          persisted: true,
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("rejects path traversal at the MCP boundary", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "summarize_targets",
        arguments: {
          workspaceRoot,
          targets: ["../secret.txt"],
        },
      });

      expect(result.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("rejects a workspace outside the server launch boundary", async () => {
    const allowedRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    await writeFile(path.join(outsideRoot, "private.txt"), "private\n");
    const connection = await connectTestClient({ workspaceRoot: allowedRoot });

    try {
      const result = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Read the private file",
          workspaceRoot: outsideRoot,
        },
      });

      expect(result.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a workspace symlink that escapes the server boundary",
    async () => {
      const allowedRoot = await createTemporaryWorkspace();
      const outsideRoot = await createTemporaryWorkspace();
      const escapedRoot = path.join(allowedRoot, "escaped-workspace");
      await symlink(outsideRoot, escapedRoot, "dir");
      const connection = await connectTestClient({ workspaceRoot: allowedRoot });

      try {
        const result = await connection.client.callTool({
          name: "summarize_targets",
          arguments: {
            workspaceRoot: escapedRoot,
            targets: ["."],
          },
        });

        expect(result.isError).toBe(true);
      } finally {
        await connection.close();
      }
    },
  );

  it("rejects caller-selected cache destinations", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    const safeCachePath = path.join(workspaceRoot, ".cache", "ato.sqlite");
    const rejectedCachePath = path.join(outsideRoot, "caller-selected.sqlite");
    const connection = await connectTestClient({
      workspaceRoot,
      cachePath: safeCachePath,
    });

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          cachePath: rejectedCachePath,
          host: "codex",
          outcome: "succeeded",
        },
      });

      expect(result.isError).toBe(true);
      await expect(stat(rejectedCachePath)).rejects.toThrow();
    } finally {
      await connection.close();
    }
  });

  it("ignores repository cache destinations in favor of the server cache", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    const safeCachePath = path.join(workspaceRoot, ".cache", "ato.sqlite");
    const rejectedCachePath = path.join(outsideRoot, "repository-selected.sqlite");
    await writeFile(path.join(workspaceRoot, "feature.ts"), "export const value = 1;\n");
    await writeWorkspaceConfig(workspaceRoot, {
      cachePath: rejectedCachePath,
      cache: { enabled: true },
    });
    const connection = await connectTestClient({
      workspaceRoot,
      cachePath: safeCachePath,
    });

    try {
      const result = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update the feature value",
          workspaceRoot,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(getStructuredContent(result).persisted).toBe(true);
      await expect(stat(safeCachePath)).resolves.toBeDefined();
      await expect(stat(rejectedCachePath)).rejects.toThrow();
    } finally {
      await connection.close();
    }
  });

  it("skips ignored summary targets", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeFile(path.join(workspaceRoot, ".gitignore"), "secret.env\n");
    await writeFile(path.join(workspaceRoot, "secret.env"), "API_TOKEN=sk-secret\n");
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "summarize_targets",
        arguments: {
          workspaceRoot,
          targets: ["secret.env"],
        },
      });
      const structuredContent = getSummaryStructuredContent(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.summaries).toHaveLength(0);
      expect(structuredContent.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "summary_target_ignored",
            path: "secret.env",
          }),
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it("skips oversized summary targets", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeFile(path.join(workspaceRoot, "large.txt"), "x".repeat(64));
    const connection = await connectTestClient({
      security: {
        resourceLimits: {
          maxSummaryTargetFileSizeBytes: 16,
        },
      },
    });

    try {
      const result = await connection.client.callTool({
        name: "summarize_targets",
        arguments: {
          workspaceRoot,
          targets: ["large.txt"],
        },
      });
      const structuredContent = getSummaryStructuredContent(result);

      expect(result.isError).not.toBe(true);
      expect(structuredContent.summaries).toHaveLength(0);
      expect(structuredContent.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "summary_target_oversized",
            path: "large.txt",
          }),
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it("redacts secret-like values from summaries", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const fakeApiKey = createFakeOpenAiKey();
    await writeFile(
      path.join(workspaceRoot, "config.txt"),
      `API_TOKEN=${fakeApiKey}\nvisible=true\n`,
    );
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "summarize_targets",
        arguments: {
          workspaceRoot,
          targets: ["config.txt"],
          task: "Update visible configuration",
        },
      });
      const structuredContent = getSummaryStructuredContent(result);

      expect(structuredContent.summaries[0]?.snippet).toContain("[REDACTED]");
      expect(structuredContent.summaries[0]?.snippet).not.toContain(fakeApiKey);
      expect(structuredContent.summaries[0]?.redactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "secret_pattern",
          }),
        ]),
      );
    } finally {
      await connection.close();
    }
  });

  it("rejects command metadata unless explicitly enabled", async () => {
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          host: "codex",
          outcome: "succeeded",
          validation: {
            command: "pnpm test",
            passed: true,
          },
        },
      });

      expect(result.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("records workflow token accounting without double counting cached input", async () => {
    const connection = await connectTestClient();

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          host: "codex",
          outcome: "succeeded",
          tokenAccounting: {
            observed: {
              source: "provider",
              provider: "test-provider",
              model: "test-model",
              breakdown: {
                agentInputTokens: 1000,
                cachedInputTokens: 400,
                agentOutputTokens: 200,
              },
              totalTokens: 1200,
            },
            optimizerOverhead: {
              requestTokens: 20,
              responseTokens: 80,
              totalTokens: 100,
              method: "exact",
              confidence: "high",
            },
            recommendedContent: {
              tokens: 5000,
              method: "approximate",
              confidence: "medium",
            },
          },
        },
      });
      const structuredContent = (
        isObject(result) ? result.structuredContent : undefined
      ) as {
        readonly runMetric: {
          readonly tokenAccounting: {
            readonly observed: {
              readonly totalTokens: number;
            };
            readonly recommendedContent: {
              readonly tokens: number;
            };
          };
        };
      };

      expect(result.isError).not.toBe(true);
      expect(structuredContent.runMetric.tokenAccounting.observed.totalTokens).toBe(1200);
      expect(structuredContent.runMetric.tokenAccounting.recommendedContent.tokens).toBe(
        5000,
      );
    } finally {
      await connection.close();
    }
  });

  it("persists optimizer and agent usage under a shared run identifier", async () => {
    const rootPath = await createTemporaryWorkspace();
    const cachePath = path.join(rootPath, "ledger.sqlite");
    const connection = await connectTestClient({ cachePath });

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          cachePath,
          runId: "shared-run",
          taskId: "shared-task",
          host: "codex",
          outcome: "succeeded",
          optimizerCalls: [
            {
              status: "known",
              operationId: "optimizer-known",
              toolName: "build_context_pack",
              overhead: {
                requestTokens: 20,
                responseTokens: 80,
                totalTokens: 100,
                method: "exact",
                confidence: "high",
              },
            },
            {
              status: "unknown",
              operationId: "optimizer-unknown",
              toolName: "summarize_targets",
              unknownReason: "The host did not expose tool message usage.",
            },
          ],
          tokenAccounting: {
            observed: {
              source: "provider",
              breakdown: {
                agentInputTokens: 1000,
                cachedInputTokens: 400,
                agentOutputTokens: 200,
              },
              totalTokens: 1200,
            },
          },
        },
      });
      const structuredContent = (
        isObject(result) ? result.structuredContent : undefined
      ) as {
        readonly persisted: boolean;
        readonly tokenLedger: {
          readonly runId: string;
          readonly entries: readonly { readonly status: string }[];
        };
      };

      expect(result.isError).not.toBe(true);
      expect(structuredContent.persisted).toBe(true);
      expect(structuredContent.tokenLedger.runId).toBe("shared-run");
      expect(structuredContent.tokenLedger.entries).toHaveLength(3);

      const store = new SqliteStore({ databasePath: cachePath });
      await store.initialize();
      try {
        const ledger = await store.get(STORE_KINDS.tokenLedger, "shared-run");
        expect(ledger).toMatchObject({
          runId: "shared-run",
          taskId: "shared-task",
        });
        expect(ledger?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "agent_run", status: "known" }),
            expect.objectContaining({
              entryId: "optimizer:optimizer-known",
              status: "known",
            }),
            expect.objectContaining({
              entryId: "optimizer:optimizer-unknown",
              status: "unknown",
            }),
          ]),
        );
      } finally {
        await store.close();
      }
    } finally {
      await connection.close();
    }
  });

  it("attributes recorded runs to the configured workspace so eviction removes them", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, "runs.sqlite");
    const connection = await connectTestClient({ workspaceRoot, cachePath });

    try {
      const result = await connection.client.callTool({
        name: "record_run",
        arguments: {
          cachePath,
          runId: "run-a",
          taskId: "task-a",
          host: "codex",
          outcome: "succeeded",
          tokenAccounting: {
            observed: {
              source: "provider",
              breakdown: {
                agentInputTokens: 900,
                cachedInputTokens: 100,
                agentOutputTokens: 200,
              },
              totalTokens: 1100,
            },
          },
        },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await connection.close();
    }

    const workspaceHash = (await getWorkspaceIdentity(workspaceRoot)).rootHash;
    const store = new SqliteStore({ databasePath: cachePath });
    await store.initialize();
    try {
      // Both records the server produced are attributed to its workspace.
      const metrics = await store.list(STORE_KINDS.runMetric);
      const ledgers = await store.list(STORE_KINDS.tokenLedger);
      expect(metrics).toHaveLength(1);
      expect(ledgers).toHaveLength(1);
      const ledgerRecord = ledgers[0];
      if (!ledgerRecord) {
        throw new Error("expected a persisted token ledger");
      }
      expect(metrics[0]?.workspaceRootHash).toBe(workspaceHash);
      expect(ledgerRecord.workspaceRootHash).toBe(workspaceHash);

      // A different workspace and a genuinely global record are controls.
      await store.set(STORE_KINDS.tokenLedger, "run-b", ledgerRecord.value, {
        workspaceRootHash: "workspace-b-hash",
      });
      await store.set(STORE_KINDS.tokenEstimate, "estimate-global", {
        inputTokens: 1,
        totalTokens: 1,
        method: "approximate",
        confidence: "low",
      });

      const evicted = await store.deleteByWorkspace(workspaceHash);
      expect(evicted.evictedByKind[STORE_KINDS.runMetric]).toBe(1);
      expect(evicted.evictedByKind[STORE_KINDS.tokenLedger]).toBe(1);

      // Workspace A's run metric and ledger are gone; controls remain.
      await expect(store.list(STORE_KINDS.runMetric)).resolves.toEqual([]);
      await expect(store.list(STORE_KINDS.tokenLedger)).resolves.toEqual([
        expect.objectContaining({ key: "run-b" }),
      ]);
      await expect(store.list(STORE_KINDS.tokenEstimate)).resolves.toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("reports process-local, content-free workflow counters through health", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await mkdir(path.join(workspaceRoot, "src"));
    await Promise.all(
      ["feature.ts", "feature.test.ts", "legacy.ts"].map(async (fileName) => {
        await writeFile(
          path.join(workspaceRoot, "src", fileName),
          `export const ${fileName.replace(/\W/gu, "")} = true;\n`,
        );
      }),
    );
    const connection = await connectTestClient();

    try {
      const packResult = await connection.client.callTool({
        name: "build_context_pack",
        arguments: {
          task: "Update the feature behavior and tests",
          workspaceRoot,
          fallbackLimit: 1,
          rankingLimit: 1,
        },
      });
      const contextPack = getExpandableContextPack(packResult).contextPack;

      await connection.client.callTool({
        name: "expand_context",
        arguments: {
          packId: contextPack.packId,
          cursor: contextPack.expansion.nextCursor,
        },
      });
      await connection.client.callTool({
        name: "record_run",
        arguments: {
          host: "codex",
          outcome: "succeeded",
          workflow: {
            contextPackAccepted: true,
            fallbackScanPerformed: true,
          },
          validation: {
            passed: true,
          },
        },
      });
      await connection.client.callTool({
        name: "record_run",
        arguments: {
          host: "codex",
          outcome: "failed",
          validation: {
            passed: false,
          },
        },
      });

      const healthResult = await connection.client.callTool({
        name: "health",
        arguments: {},
      });
      const structuredContent = (
        isObject(healthResult) ? healthResult.structuredContent : undefined
      ) as {
        readonly observability: {
          readonly contextPackAccepted: number;
          readonly expansionRequested: number;
          readonly fallbackScanPerformed: number;
          readonly validationPassed: number;
          readonly validationFailed: number;
        };
      };

      expect(healthResult.isError).not.toBe(true);
      expect(structuredContent.observability).toEqual({
        contextPackAccepted: 1,
        expansionRequested: 1,
        fallbackScanPerformed: 1,
        validationPassed: 1,
        validationFailed: 1,
      });
    } finally {
      await connection.close();
    }
  });
});

async function connectTestClient(
  options: Parameters<typeof createAgentTokenOptimizerMcpServer>[0] = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const logSink = new MemoryLogSink();
  const server = createAgentTokenOptimizerMcpServer({
    packageVersion: "0.0.0-test",
    workspaceRoot: os.tmpdir(),
    logger: createLogger({
      component: "mcp-test",
      sink: logSink,
    }),
    ...options,
  });
  const client = new Client({
    name: "test-client",
    version: "0.0.0-test",
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    logSink,
    async close() {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

async function createTemporaryWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-mcp-"));
  temporaryRoots.push(rootPath);

  return rootPath;
}

async function writeWorkspaceConfig(
  workspaceRoot: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const configPath = path.join(workspaceRoot, ".agent-token-optimizer", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        workspaceRoot,
        mcp: { command: "agent-token-optimizer mcp" },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

function getStructuredContent(result: unknown): {
  readonly persisted: boolean;
  readonly workspaceTotals: {
    readonly filesIndexed: number;
  };
  readonly contextPack: {
    readonly budget: {
      readonly response: { readonly limitTokens: number; readonly usedTokens: number };
      readonly recommendedContent: { readonly limitTokens: number };
    };
    readonly selected: readonly {
      readonly path: string;
    }[];
    readonly summaries: readonly { readonly summary: string }[];
  };
} {
  return (isObject(result) ? result.structuredContent : undefined) as {
    readonly persisted: boolean;
    readonly workspaceTotals: {
      readonly filesIndexed: number;
    };
    readonly contextPack: {
      readonly budget: {
        readonly response: { readonly limitTokens: number; readonly usedTokens: number };
        readonly recommendedContent: { readonly limitTokens: number };
      };
      readonly selected: readonly {
        readonly path: string;
      }[];
      readonly summaries: readonly { readonly summary: string }[];
    };
  };
}

function getContent(result: unknown): readonly unknown[] {
  return isObject(result) && Array.isArray(result.content) ? result.content : [];
}

function getExpandableContextPack(result: unknown): {
  readonly persisted: boolean;
  readonly contextPack: {
    readonly packId: string;
    readonly selected: readonly { readonly signals: readonly unknown[] }[];
    readonly excluded: readonly { readonly signals: readonly unknown[] }[];
    readonly omittedCandidateCount: number;
    readonly expansion: { readonly nextCursor: string };
  };
} {
  return (isObject(result) ? result.structuredContent : undefined) as {
    readonly persisted: boolean;
    readonly contextPack: {
      readonly packId: string;
      readonly selected: readonly { readonly signals: readonly unknown[] }[];
      readonly excluded: readonly { readonly signals: readonly unknown[] }[];
      readonly omittedCandidateCount: number;
      readonly expansion: { readonly nextCursor: string };
    };
  };
}

function getExpansionPage(result: unknown): {
  readonly page: {
    readonly packId: string;
    readonly candidates: readonly { readonly signals: readonly unknown[] }[];
    readonly hasMore: boolean;
    readonly remainingCandidateCount: number;
  };
  readonly warnings: readonly unknown[];
} {
  return (isObject(result) ? result.structuredContent : undefined) as {
    readonly page: {
      readonly packId: string;
      readonly candidates: readonly { readonly signals: readonly unknown[] }[];
      readonly hasMore: boolean;
      readonly remainingCandidateCount: number;
    };
    readonly warnings: readonly unknown[];
  };
}

function getSummaryStructuredContent(result: unknown): {
  readonly summaries: readonly {
    readonly summary: string;
    readonly snippet?: string;
    readonly redactions: readonly {
      readonly reason: string;
    }[];
  }[];
  readonly warnings: readonly {
    readonly code: string;
    readonly path?: string;
  }[];
} {
  return (isObject(result) ? result.structuredContent : undefined) as {
    readonly summaries: readonly {
      readonly summary: string;
      readonly snippet?: string;
      readonly redactions: readonly {
        readonly reason: string;
      }[];
    }[];
    readonly warnings: readonly {
      readonly code: string;
      readonly path?: string;
    }[];
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createFakeOpenAiKey(): string {
  return `${"sk"}-${"1234567890abcdef"}`;
}
