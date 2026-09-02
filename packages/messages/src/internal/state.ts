import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface ProviderCheckpoint {
  readonly databaseGeneration: string;
  readonly rowId: number;
  readonly witnesses?: readonly ProviderCheckpointWitness[];
  readonly version: 1;
}

export interface ProviderCheckpointWitness {
  readonly providerMessageDigest: string;
  readonly rowId: number;
}

const MAX_CHECKPOINT_WITNESSES = 4;

export interface CheckpointStore {
  advance(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<void>;
  checkpoint(databaseGeneration: string): Promise<ProviderCheckpoint | undefined>;
  currentCheckpoint(): Promise<ProviderCheckpoint | undefined>;
  initialize(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<boolean>;
}

interface ProviderStateV2 {
  readonly checkpoint: ProviderCheckpoint | null;
  readonly legacyUnscopedCursor?: number;
  readonly version: 2;
}

const EMPTY_STATE: ProviderStateV2 = { checkpoint: null, version: 2 };

function nextCheckpoint(
  current: ProviderCheckpoint | undefined,
  databaseGeneration: string,
  rowId: number,
  witness?: ProviderCheckpointWitness,
): ProviderCheckpoint {
  if (databaseGeneration.trim() === "" || !Number.isSafeInteger(rowId) || rowId < 0) {
    throw new Error("provider_checkpoint_invalid");
  }
  if (witness !== undefined && !validWitness(witness, rowId)) {
    throw new Error("provider_checkpoint_invalid");
  }
  const retained = current?.databaseGeneration === databaseGeneration
    ? [...(current.witnesses ?? [])]
    : [];
  const witnesses = witness === undefined
    ? retained
    : [...retained.filter((candidate) => candidate.rowId !== witness.rowId), witness]
      .sort((left, right) => left.rowId - right.rowId)
      .slice(-MAX_CHECKPOINT_WITNESSES);
  return {
    databaseGeneration,
    rowId: current?.databaseGeneration === databaseGeneration
      ? Math.max(current.rowId, rowId)
      : rowId,
    ...(witnesses.length === 0 ? {} : { witnesses }),
    version: 1,
  };
}

export class ProviderStateStore implements CheckpointStore {
  readonly #path: string;
  readonly #legacyUnscopedCursor: number | undefined;
  #operation: Promise<void> = Promise.resolve();

  constructor(path: string, input: { readonly legacyUnscopedCursor?: number } = {}) {
    if (path.trim() === "") throw new Error("provider_state_path_invalid");
    if (
      input.legacyUnscopedCursor !== undefined &&
      nonNegativeInteger(input.legacyUnscopedCursor) === undefined
    ) {
      throw new Error("provider_checkpoint_invalid");
    }
    this.#path = path;
    this.#legacyUnscopedCursor = input.legacyUnscopedCursor;
  }

  checkpoint(databaseGeneration: string): Promise<ProviderCheckpoint | undefined> {
    return this.#serialized(async () => {
      const state = await this.#load();
      return state.checkpoint?.databaseGeneration === databaseGeneration
        ? state.checkpoint
        : undefined;
    });
  }

  currentCheckpoint(): Promise<ProviderCheckpoint | undefined> {
    return this.#serialized(async () => (await this.#load()).checkpoint ?? undefined);
  }

  advance(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<void> {
    return this.#serialized(async () => {
      const state = await this.#load();
      await this.#save({
        checkpoint: nextCheckpoint(
          state.checkpoint ?? undefined,
          databaseGeneration,
          rowId,
          witness,
        ),
        ...(state.legacyUnscopedCursor === undefined
          ? {}
          : { legacyUnscopedCursor: state.legacyUnscopedCursor }),
        version: 2,
      });
    });
  }

  initialize(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<boolean> {
    return this.#serialized(async () => {
      const state = await this.#load();
      if (state.checkpoint !== null) return false;
      await this.#save({
        checkpoint: nextCheckpoint(undefined, databaseGeneration, rowId, witness),
        ...(state.legacyUnscopedCursor === undefined
          ? {}
          : { legacyUnscopedCursor: state.legacyUnscopedCursor }),
        version: 2,
      });
      return true;
    });
  }

  async #load(): Promise<ProviderStateV2> {
    await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
    let source: string;
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("provider_state_path_unsafe");
      }
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.#legacyUnscopedCursor === undefined) return EMPTY_STATE;
        const initial: ProviderStateV2 = {
          checkpoint: null,
          legacyUnscopedCursor: this.#legacyUnscopedCursor,
          version: 2,
        };
        await this.#save(initial);
        return initial;
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("provider_state_invalid");
    }
    const record = object(value);
    if (record.version === 1) return await this.#migrateV1(record);
    if (record.version !== 2) throw new Error("provider_state_version_unsupported");
    return parseV2(record);
  }

  async #migrateV1(value: Record<string, unknown>): Promise<ProviderStateV2> {
    const cursor = nonNegativeInteger(value.cursor);
    if (cursor === undefined) throw new Error("provider_state_invalid");
    try {
      await copyFile(this.#path, `${this.#path}.v1.backup`, constants.COPYFILE_EXCL);
      await chmod(`${this.#path}.v1.backup`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const migrated: ProviderStateV2 = {
      checkpoint: null,
      legacyUnscopedCursor: cursor,
      version: 2,
    };
    await this.#save(migrated);
    return migrated;
  }

  async #save(state: ProviderStateV2): Promise<void> {
    const temporaryPath = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  #checkpoint: ProviderCheckpoint | undefined;

  async checkpoint(databaseGeneration: string): Promise<ProviderCheckpoint | undefined> {
    return this.#checkpoint?.databaseGeneration === databaseGeneration
      ? this.#checkpoint
      : undefined;
  }

  async currentCheckpoint(): Promise<ProviderCheckpoint | undefined> {
    return this.#checkpoint;
  }

  async initialize(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<boolean> {
    if (this.#checkpoint !== undefined) return false;
    this.#checkpoint = nextCheckpoint(undefined, databaseGeneration, rowId, witness);
    return true;
  }

  async advance(
    databaseGeneration: string,
    rowId: number,
    witness?: ProviderCheckpointWitness,
  ): Promise<void> {
    this.#checkpoint = nextCheckpoint(this.#checkpoint, databaseGeneration, rowId, witness);
  }
}

function parseV2(value: Record<string, unknown>): ProviderStateV2 {
  const checkpoint = value.checkpoint;
  const legacyUnscopedCursor = value.legacyUnscopedCursor;
  if (checkpoint !== null && checkpoint !== undefined) {
    const candidate = object(checkpoint);
    const rowId = nonNegativeInteger(candidate.rowId);
    if (
      candidate.version !== 1 ||
      typeof candidate.databaseGeneration !== "string" ||
      candidate.databaseGeneration.trim() === "" ||
      rowId === undefined
    ) {
      throw new Error("provider_state_invalid");
    }
    if (legacyUnscopedCursor !== undefined && nonNegativeInteger(legacyUnscopedCursor) === undefined) {
      throw new Error("provider_state_invalid");
    }
    return {
      checkpoint: {
        databaseGeneration: candidate.databaseGeneration,
        rowId,
        ...providerCheckpointWitnessList(candidate, rowId),
        version: 1,
      },
      ...(legacyUnscopedCursor === undefined
        ? {}
        : { legacyUnscopedCursor: Number(legacyUnscopedCursor) }),
      version: 2,
    };
  }
  if (legacyUnscopedCursor !== undefined && nonNegativeInteger(legacyUnscopedCursor) === undefined) {
    throw new Error("provider_state_invalid");
  }
  return {
    checkpoint: null,
    ...(legacyUnscopedCursor === undefined
      ? {}
      : { legacyUnscopedCursor: Number(legacyUnscopedCursor) }),
    version: 2,
  };
}

function providerCheckpointWitness(value: unknown, checkpointRowId: number): ProviderCheckpointWitness {
  const witness = object(value);
  const rowId = nonNegativeInteger(witness.rowId);
  if (
    rowId === undefined || rowId <= 0 || rowId > checkpointRowId ||
    typeof witness.providerMessageDigest !== "string" || witness.providerMessageDigest.trim() === ""
  ) {
    throw new Error("provider_state_invalid");
  }
  return {
    providerMessageDigest: witness.providerMessageDigest,
    rowId,
  };
}

function providerCheckpointWitnessList(
  checkpoint: Record<string, unknown>,
  checkpointRowId: number,
): { readonly witnesses?: readonly ProviderCheckpointWitness[] } {
  const source = checkpoint.witnesses ??
    (checkpoint.witness === undefined ? undefined : [checkpoint.witness]);
  if (source === undefined) return {};
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_CHECKPOINT_WITNESSES) {
    throw new Error("provider_state_invalid");
  }
  const witnesses = source.map((value) => providerCheckpointWitness(value, checkpointRowId));
  if (new Set(witnesses.map((witness) => witness.rowId)).size !== witnesses.length) {
    throw new Error("provider_state_invalid");
  }
  return { witnesses: witnesses.sort((left, right) => left.rowId - right.rowId) };
}

function validWitness(witness: ProviderCheckpointWitness, checkpointRowId: number): boolean {
  return Number.isSafeInteger(witness.rowId) && witness.rowId > 0 &&
    witness.rowId <= checkpointRowId && witness.providerMessageDigest.trim() !== "";
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider_state_invalid");
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
