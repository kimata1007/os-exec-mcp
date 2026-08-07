import { randomUUID } from "node:crypto";

export type OutputArtifact = {
  uri: string;
  text: string;
  totalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  expiresAt: number;
};

type StoredArtifact = OutputArtifact & { id: string };

export class OutputArtifactStore {
  readonly #artifacts = new Map<string, StoredArtifact>();
  #retainedBytes = 0;

  public constructor(
    private readonly timeToLiveMs: number,
    private readonly maximumRetainedBytes: number,
  ) {}

  public put(text: string, totalBytes: number, truncated: boolean): string | undefined {
    this.#purgeExpired();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes === 0 || bytes > this.maximumRetainedBytes) {
      return undefined;
    }
    if (this.#retainedBytes + bytes > this.maximumRetainedBytes) {
      return undefined;
    }
    const id = randomUUID();
    const uri = `os-exec-output:///${id}`;
    const artifact: StoredArtifact = {
      id,
      uri,
      text,
      totalBytes,
      retainedBytes: bytes,
      truncated,
      expiresAt: Date.now() + this.timeToLiveMs,
    };
    this.#artifacts.set(id, artifact);
    this.#retainedBytes += bytes;
    return uri;
  }

  public get(uriOrId: string): OutputArtifact | undefined {
    this.#purgeExpired();
    const id = uriOrId.startsWith("os-exec-output:")
      ? new URL(uriOrId).pathname.slice(1)
      : uriOrId;
    const artifact = this.#artifacts.get(id);
    if (artifact === undefined) {
      return undefined;
    }
    return {
      uri: artifact.uri,
      text: artifact.text,
      totalBytes: artifact.totalBytes,
      retainedBytes: artifact.retainedBytes,
      truncated: artifact.truncated,
      expiresAt: artifact.expiresAt,
    };
  }

  public clear(): void {
    this.#artifacts.clear();
    this.#retainedBytes = 0;
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [id, artifact] of this.#artifacts) {
      if (artifact.expiresAt > now) {
        break;
      }
      this.#delete(id);
    }
  }

  #delete(id: string): void {
    const artifact = this.#artifacts.get(id);
    if (artifact === undefined) {
      return;
    }
    this.#artifacts.delete(id);
    this.#retainedBytes -= artifact.retainedBytes;
  }
}
