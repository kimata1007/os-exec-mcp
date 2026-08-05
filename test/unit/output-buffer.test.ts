import { describe, expect, it } from "vitest";

import { OutputBuffer } from "../../src/executor/output-buffer.js";

describe("OutputBuffer", () => {
  it("captures output below the limit", () => {
    const output = new OutputBuffer(8);
    output.append(Buffer.from("hello"));

    expect(output.result()).toEqual({
      text: "hello",
      totalBytes: 5,
      truncated: false,
    });
  });

  it("keeps counting after truncation without retaining extra bytes", () => {
    const output = new OutputBuffer(4);
    output.append(Buffer.from("abc"));
    output.append(Buffer.from("defgh"));

    expect(output.result()).toEqual({
      text: "abcd",
      totalBytes: 8,
      truncated: true,
    });
  });

  it("replaces invalid UTF-8 rather than throwing", () => {
    const output = new OutputBuffer(8);
    output.append(Buffer.from([0xff, 0xfe, 0x61]));

    expect(output.result().text).toContain("a");
  });
});
