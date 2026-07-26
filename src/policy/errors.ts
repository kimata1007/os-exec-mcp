export class PolicyRejectionError extends Error {
  public override readonly name = "PolicyRejectionError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
