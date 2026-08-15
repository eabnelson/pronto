export interface ProcessSpec {
  args: string[];
  env: Record<string, string>;
  executable: string;
  maxOutputBytes?: number;
  killGraceMs?: number;
  stdin: string;
  timeoutMs?: number;
  workingDirectory: string;
}

export interface ProcessExecution {
  exitCode: number;
  outputLimitExceeded: boolean;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessExecution>;
}

export class ProcessSpawnError extends Error {
  constructor(cause: unknown) {
    super("Unable to spawn runtime", { cause });
    this.name = "ProcessSpawnError";
  }
}

export class BoundedProcessRunner implements ProcessRunner {
  async run(spec: ProcessSpec): Promise<ProcessExecution> {
    const maxOutputBytes = spec.maxOutputBytes ?? 1_000_000;
    let child;
    try {
      child = Bun.spawn([spec.executable, ...spec.args], {
        cwd: spec.workingDirectory,
        detached: true,
        env: { ...process.env, ...spec.env },
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
      });
    } catch (error) {
      throw new ProcessSpawnError(error);
    }
    let outputLimitExceeded = false;
    let timedOut = false;
    let capturedBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process already exited.
        }
      }
    };

    const terminateGroup = () => {
      terminate("SIGTERM");
      killTimer ??= setTimeout(() => terminate("SIGKILL"), spec.killGraceMs ?? 2_000);
    };

    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = maxOutputBytes - capturedBytes;
          if (remaining <= 0) {
            outputLimitExceeded = true;
            terminateGroup();
            continue;
          }
          const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
          text += decoder.decode(chunk, { stream: true });
          capturedBytes += chunk.byteLength;
          if (value.byteLength > remaining) {
            outputLimitExceeded = true;
            terminateGroup();
          }
        }
        text += decoder.decode();
        return text;
      } finally {
        reader.releaseLock();
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, spec.timeoutMs ?? 10 * 60 * 1_000);

    child.stdin.write(spec.stdin);
    child.stdin.end();
    const [actualExitCode, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ]);
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    return {
      exitCode: outputLimitExceeded || timedOut ? 1 : actualExitCode,
      outputLimitExceeded,
      stderr,
      stdout,
      timedOut,
    };
  }
}
