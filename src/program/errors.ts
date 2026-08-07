export class ProgramExecutionError extends Error {
  public override readonly name = "ProgramExecutionError";

  public constructor(
    public readonly code:
      | "cancelled"
      | "execution_failed"
      | "memory_limit"
      | "result_too_large"
      | "timeout",
    message: string,
  ) {
    super(message.slice(0, 4096));
  }
}
