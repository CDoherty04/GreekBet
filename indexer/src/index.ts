/** Public surface, for embedding the indexer in another process (plan §4, Option C). */

export { Decoder, DecodeError, PROGRAM_ID } from "./decoder";
export { CheckpointStore, EMPTY_CHECKPOINT, type CheckpointState } from "./checkpoint";
export { Deduplicator, type DeduplicatorOptions } from "./dedup";
export { Indexer, consoleLogger, type IndexerOptions, type IndexerStats, type Logger } from "./indexer";
export { RpcChainSource, isTransient, type ChainSource, type RpcOptions } from "./rpc";
export type { OutputAdapter } from "./output/adapter";
export { JsonlOutput, type JsonlOutputOptions } from "./output/jsonl";
export { MemoryOutput, FailingOutput } from "./output/memory";
export * from "./types";
