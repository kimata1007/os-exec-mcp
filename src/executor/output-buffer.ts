import type { OutputCapture } from "./types.js";

export type CapturedOutput = {
  text: string;
  totalBytes: number;
  truncated: boolean;
  persistedText?: string;
  persistedTruncated?: boolean;
};

function stripAnsiSequences(text: string): string {
  let stripped = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 0x1b && code !== 0x9b) {
      stripped += text[index] ?? "";
      continue;
    }

    const introducer = code === 0x9b ? 0x5b : text.charCodeAt(index + 1);
    if (code === 0x1b) {
      index += 1;
    }
    if (introducer === 0x5d) {
      while (index + 1 < text.length) {
        index += 1;
        const current = text.charCodeAt(index);
        if (current === 0x07) {
          break;
        }
        if (current === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
          index += 1;
          break;
        }
      }
      continue;
    }
    if (introducer === 0x5b) {
      while (index + 1 < text.length) {
        index += 1;
        const current = text.charCodeAt(index);
        if (current >= 0x40 && current <= 0x7e) {
          break;
        }
      }
    }
  }
  return stripped;
}

function normalize(text: string, stripAnsi: boolean): string {
  const withoutCarriageReturns = text.replaceAll("\r", "");
  return stripAnsi
    ? stripAnsiSequences(withoutCarriageReturns)
    : withoutCarriageReturns;
}

function decodeWithin(buffer: Buffer, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return "";
  }
  let end = Math.min(buffer.length, maximumBytes);
  let value = buffer.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(value, "utf8") > maximumBytes && end > 0) {
    end -= 1;
    value = buffer.subarray(0, end).toString("utf8");
  }
  return value;
}

function decodeTailWithin(buffer: Buffer, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return "";
  }
  let start = Math.max(0, buffer.length - maximumBytes);
  let value = buffer.subarray(start).toString("utf8");
  while (Buffer.byteLength(value, "utf8") > maximumBytes && start < buffer.length) {
    start += 1;
    value = buffer.subarray(start).toString("utf8");
  }
  return value;
}

function omissionMarker(omittedBytes: number, maximumBytes: number): string {
  const verbose = `\n... ${omittedBytes} bytes omitted ...\n`;
  if (Buffer.byteLength(verbose) <= maximumBytes) {
    return verbose;
  }
  const compact = `...${omittedBytes}B...`;
  if (Buffer.byteLength(compact) <= maximumBytes) {
    return compact;
  }
  return ".".repeat(maximumBytes);
}

export class OutputBuffer {
  readonly #headChunks: Buffer[] = [];
  readonly #tailChunks: Buffer[] = [];
  readonly #persistedChunks: Buffer[] = [];
  #headBytes = 0;
  #tailBytes = 0;
  #totalBytes = 0;
  #persistedBytes = 0;

  public constructor(
    private readonly maximumBytes: number,
    private readonly capture: OutputCapture = "head",
    private readonly stripAnsi = false,
    private readonly persistedMaximumBytes = 0,
  ) {}

  public append(chunk: Buffer): void {
    this.#totalBytes += chunk.length;

    const persistedRemaining = this.persistedMaximumBytes - this.#persistedBytes;
    if (persistedRemaining > 0) {
      const persisted =
        chunk.length <= persistedRemaining
          ? chunk
          : chunk.subarray(0, persistedRemaining);
      this.#persistedChunks.push(Buffer.from(persisted));
      this.#persistedBytes += persisted.length;
    }

    const headRemaining = this.maximumBytes - this.#headBytes;
    if (headRemaining > 0) {
      const captured =
        chunk.length <= headRemaining ? chunk : chunk.subarray(0, headRemaining);
      this.#headChunks.push(Buffer.from(captured));
      this.#headBytes += captured.length;
    }

    if (this.capture === "head_tail") {
      this.#tailChunks.push(Buffer.from(chunk));
      this.#tailBytes += chunk.length;
      while (this.#tailBytes > this.maximumBytes && this.#tailChunks.length > 0) {
        const first = this.#tailChunks[0];
        if (first === undefined) {
          break;
        }
        const excess = this.#tailBytes - this.maximumBytes;
        if (first.length <= excess) {
          this.#tailChunks.shift();
          this.#tailBytes -= first.length;
        } else {
          this.#tailChunks[0] = Buffer.from(first.subarray(excess));
          this.#tailBytes -= excess;
        }
      }
    }
  }

  public result(): CapturedOutput {
    const truncated = this.#totalBytes > this.maximumBytes;
    const head = Buffer.concat(this.#headChunks, this.#headBytes);
    if (!truncated || this.capture === "head") {
      return {
        text: normalize(decodeWithin(head, this.maximumBytes), this.stripAnsi),
        totalBytes: this.#totalBytes,
        truncated,
        ...this.#persistedResult(),
      };
    }

    const tail = Buffer.concat(this.#tailChunks, this.#tailBytes);
    let marker = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const contentBudget = Math.max(0, this.maximumBytes - Buffer.byteLength(marker));
      const provisionalHeadBudget = Math.floor(contentBudget / 4);
      const provisionalTailBudget = contentBudget - provisionalHeadBudget;
      const omitted = Math.max(
        0,
        this.#totalBytes - provisionalHeadBudget - provisionalTailBudget,
      );
      marker = omissionMarker(omitted, this.maximumBytes);
    }
    const markerBytes = Buffer.byteLength(marker);
    const contentBudget = Math.max(0, this.maximumBytes - markerBytes);
    const headBudget = Math.floor(contentBudget / 4);
    const tailBudget = contentBudget - headBudget;

    return {
      text: `${normalize(decodeWithin(head, headBudget), this.stripAnsi)}${marker}${normalize(
        decodeTailWithin(tail, tailBudget),
        this.stripAnsi,
      )}`,
      totalBytes: this.#totalBytes,
      truncated: true,
      ...this.#persistedResult(),
    };
  }

  #persistedResult(): Pick<CapturedOutput, "persistedText" | "persistedTruncated"> {
    if (this.persistedMaximumBytes === 0 || this.#totalBytes <= this.maximumBytes) {
      return {};
    }
    const captured = Buffer.concat(this.#persistedChunks, this.#persistedBytes);
    return {
      persistedText: normalize(captured.toString("utf8"), this.stripAnsi),
      persistedTruncated: this.#totalBytes > this.persistedMaximumBytes,
    };
  }
}
