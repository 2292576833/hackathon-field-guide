export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly recoveryAction?: string;
    readonly latestRevision?: number;
  };
  readonly requestId: string;
}

export interface DomainErrorOptions {
  readonly status?: number;
  readonly recoveryAction?: string;
  readonly latestRevision?: number;
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly recoveryAction: string | undefined;
  readonly latestRevision: number | undefined;

  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = options.status ?? 422;
    this.recoveryAction = options.recoveryAction;
    this.latestRevision = options.latestRevision;
  }
}

/**
 * Next production bundles can load a second copy of this module. Keep the
 * HTTP boundary's status and error envelope stable across those copies while
 * still rejecting arbitrary objects that merely contain a status field.
 */
export function isDomainError(error: unknown): error is DomainError {
  if (error instanceof DomainError) return true;
  if (!(error instanceof Error) || error.name !== "DomainError") return false;
  const value = error as Partial<DomainError>;
  const status = value.status;
  return typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.code)
    && typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

/** Unknown exceptions deliberately do not disclose stacks or provider responses. */
export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  if (!isDomainError(error)) {
    return { error: { code: "INTERNAL_ERROR", message: "服务暂时无法完成操作，请稍后重试。" }, requestId };
  }
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.recoveryAction !== undefined ? { recoveryAction: error.recoveryAction } : {}),
      ...(error.latestRevision !== undefined ? { latestRevision: error.latestRevision } : {}),
    },
    requestId,
  };
}
