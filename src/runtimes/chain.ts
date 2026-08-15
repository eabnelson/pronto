import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "./types";

export type ChainedRuntimeResult = RuntimeAttemptResult & {
  runtime: "codex" | "claude";
};

export interface RuntimeChainOptions {
  fallbackInput?: () => RuntimeInput;
  onResult?: (
    runtime: "codex" | "claude",
    result: RuntimeAttemptResult,
  ) => void | Promise<void>;
}

function freezeInput(input: RuntimeInput): Readonly<RuntimeInput> {
  return Object.freeze({ ...input });
}

function sameContext(primary: RuntimeInput, fallback: RuntimeInput): boolean {
  return (
    JSON.stringify(primary.bridgeExecutableArgs ?? []) ===
      JSON.stringify(fallback.bridgeExecutableArgs ?? []) &&
    primary.bridgeExecutablePath === fallback.bridgeExecutablePath &&
    primary.brokerUrl === fallback.brokerUrl &&
    primary.prompt === fallback.prompt &&
    primary.workingDirectory === fallback.workingDirectory
  );
}

export class RuntimeChain {
  constructor(
    readonly primary: RuntimeAdapter,
    readonly fallback?: RuntimeAdapter,
  ) {}

  async run(input: RuntimeInput, options: RuntimeChainOptions = {}): Promise<ChainedRuntimeResult> {
    const immutableInput = freezeInput(input);
    const primaryResult = await this.primary.run(immutableInput);
    await options.onResult?.(this.primary.kind, primaryResult);
    if (
      primaryResult.status !== "operational-failure" ||
      primaryResult.toolActivity !== "none" ||
      this.fallback === undefined
    ) {
      return { ...primaryResult, runtime: this.primary.kind };
    }
    const fallbackInput =
      options.fallbackInput === undefined ? immutableInput : freezeInput(options.fallbackInput());
    if (!sameContext(immutableInput, fallbackInput)) {
      throw new Error("Fallback runtime context must match the primary context");
    }
    const fallbackResult = await this.fallback.run(fallbackInput);
    await options.onResult?.(this.fallback.kind, fallbackResult);
    return { ...fallbackResult, runtime: this.fallback.kind };
  }
}
