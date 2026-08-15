import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "./types";

export type ChainedRuntimeResult = RuntimeAttemptResult & {
  runtime: "codex" | "claude";
};

export class RuntimeChain {
  constructor(
    readonly primary: RuntimeAdapter,
    readonly fallback?: RuntimeAdapter,
  ) {}

  async run(input: RuntimeInput): Promise<ChainedRuntimeResult> {
    const immutableInput = Object.freeze({ ...input });
    const primaryResult = await this.primary.run(immutableInput);
    if (
      primaryResult.status !== "operational-failure" ||
      primaryResult.toolActivity !== "none" ||
      this.fallback === undefined
    ) {
      return { ...primaryResult, runtime: this.primary.kind };
    }
    const fallbackResult = await this.fallback.run(immutableInput);
    return { ...fallbackResult, runtime: this.fallback.kind };
  }
}
