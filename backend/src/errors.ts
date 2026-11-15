import type { ErrorCode } from "../../shared/contract";

/** An error we expect and can explain to the extension. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}
