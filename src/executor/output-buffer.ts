export type CapturedOutput = {
  text: string;
  totalBytes: number;
  truncated: boolean;
};

export class OutputBuffer {
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;

  public constructor(private readonly maximumBytes: number) {}

  public append(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    const remaining = this.maximumBytes - this.#capturedBytes;
    if (remaining <= 0) {
      return;
    }

    const captured = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.#chunks.push(Buffer.from(captured));
    this.#capturedBytes += captured.length;
  }

  public result(): CapturedOutput {
    return {
      text: Buffer.concat(this.#chunks, this.#capturedBytes).toString("utf8"),
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.maximumBytes,
    };
  }
}
