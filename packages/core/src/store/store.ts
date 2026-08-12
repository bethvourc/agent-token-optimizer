import type {
  BenchmarkScenario,
  UserPromptHookEvidence,
  ContextPack,
  ContextRankingEvidence,
  FileSummary,
  RunMetric,
  TokenLedger,
  TokenEstimate,
  WorkspaceAnalysisIndex,
  WorkspaceIndex,
} from "../contracts";

export const STORE_KINDS = {
  benchmarkScenario: "benchmark_scenario",
  userPromptHookEvidence: "user_prompt_hook_evidence",
  contextPack: "context_pack",
  contextRanking: "context_ranking",
  fileSummary: "file_summary",
  runMetric: "run_metric",
  tokenLedger: "token_ledger",
  tokenEstimate: "token_estimate",
  workspaceAnalysis: "workspace_analysis",
  workspaceIndex: "workspace_index",
} as const;

export type StoreRecordKind = (typeof STORE_KINDS)[keyof typeof STORE_KINDS];

export interface StoreValueByKind {
  readonly [STORE_KINDS.benchmarkScenario]: BenchmarkScenario;
  readonly [STORE_KINDS.userPromptHookEvidence]: UserPromptHookEvidence;
  readonly [STORE_KINDS.contextPack]: ContextPack;
  readonly [STORE_KINDS.contextRanking]: ContextRankingEvidence;
  readonly [STORE_KINDS.fileSummary]: FileSummary;
  readonly [STORE_KINDS.runMetric]: RunMetric;
  readonly [STORE_KINDS.tokenLedger]: TokenLedger;
  readonly [STORE_KINDS.tokenEstimate]: TokenEstimate;
  readonly [STORE_KINDS.workspaceAnalysis]: WorkspaceAnalysisIndex;
  readonly [STORE_KINDS.workspaceIndex]: WorkspaceIndex;
}

export interface StoreRecord<TValue = unknown> {
  readonly kind: StoreRecordKind;
  readonly key: string;
  readonly value: TValue;
  readonly contentHash?: string;
  readonly workspaceRootHash?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreSetOptions {
  readonly contentHash?: string;
  readonly workspaceRootHash?: string;
  readonly now?: Date;
}

export interface WorkspaceEvictionResult {
  readonly workspaceRootHash: string;
  readonly evicted: number;
  readonly evictedByKind: Readonly<Partial<Record<StoreRecordKind, number>>>;
}

export interface StoreHealth {
  readonly ok: boolean;
  readonly databasePath: string;
  readonly migrationsApplied: readonly number[];
  readonly records: number;
}

export interface AgentTokenStore {
  initialize: () => Promise<void>;
  close: () => Promise<void>;
  repair: () => Promise<void>;
  health: () => Promise<StoreHealth>;
  get: <TKind extends StoreRecordKind>(
    kind: TKind,
    key: string,
  ) => Promise<StoreValueByKind[TKind] | undefined>;
  set: <TKind extends StoreRecordKind>(
    kind: TKind,
    key: string,
    value: StoreValueByKind[TKind],
    options?: StoreSetOptions,
  ) => Promise<StoreRecord<StoreValueByKind[TKind]>>;
  list: <TKind extends StoreRecordKind>(
    kind: TKind,
  ) => Promise<StoreRecord<StoreValueByKind[TKind]>[]>;
  delete: (kind: StoreRecordKind, key: string) => Promise<boolean>;
  deleteByWorkspace: (workspaceRootHash: string) => Promise<WorkspaceEvictionResult>;
  clear: (kind?: StoreRecordKind) => Promise<number>;
}

export class StoreCorruptionError extends Error {
  public constructor(
    message: string,
    public readonly databasePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoreCorruptionError";
  }
}
