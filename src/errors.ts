/**
 * Error taxonomy for dsh-bridge.
 *
 * Every failure a caller can act on has its own class and a message that names
 * the endpoint, host, status, or credential that caused it. The CLI prints
 * `error.message` on stderr and exits 1 for all of these; `SendResult` carries
 * the turn-level statuses instead.
 */

/** A local, pre-flight, or protocol failure. Always exit code 1. */
export class BridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Credentials file / record / secret problems. */
export class CredentialsError extends BridgeError {}

/** The optional user config file is unreadable, malformed, or has unknown keys. */
export class ConfigError extends BridgeError {}

/** HTTP status, envelope, or endpoint mismatch. */
export class ProtocolError extends BridgeError {}

/** Transport could not reach the host, or the host is not a DSH host. */
export class HostError extends BridgeError {}

/** A DSH RPC answered with `result.ok === false`. */
export class RpcError extends BridgeError {
  readonly code: string;
  readonly details: unknown;

  constructor(endpoint: string, code: string, message: string, details?: unknown) {
    super(`${endpoint} failed: ${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

/** No session matched, or the selector itself was invalid. */
export class ResolutionError extends BridgeError {}

/** More than one session matched. */
export class AmbiguousTargetError extends ResolutionError {
  readonly candidates: SessionCandidate[];

  constructor(message: string, candidates: SessionCandidate[]) {
    super(message);
    this.candidates = candidates;
  }
}

/** A selector was syntactically valid but cannot be applied to the rows. */
export class SessionCandidate {
  constructor(
    readonly sessionId: string,
    readonly title: string | undefined,
    readonly cwd: string | undefined,
    readonly updatedAt: number | undefined,
  ) {}
}

/** `result` could not find the rpcId locally or on the host. */
export class ResultNotFoundError extends BridgeError {}

/** `setup` cannot render or write a usable harness config. */
export class SetupError extends BridgeError {}
