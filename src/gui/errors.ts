/**
 * Turns any thrown value into a readable message for a toast.
 *
 * `client.rpc(...)` (see `@opencode/client`'s `makeRpc`) does not throw an
 * `Error` on a failed call: it throws a plain object shaped like
 * `{ type, message, data? }` (a `RpcError`/`RpcInternalError`). A bare
 * `String(cause)` on that object stringifies to `"[object Object]"`, which is
 * what a flaky `executionBegin`/`getWorkItem`/`getFlow` call showed in the
 * toast. Every catch that renders a toast or an inline error must go through
 * this helper instead of inlining `instanceof Error ? ... : String(...)`.
 */

/** An RPC failure shape: `client.rpc(...)` throws this, never an `Error`. */
type RpcLikeError = { message: unknown; type?: unknown };

const isRpcLikeError = (value: unknown): value is RpcLikeError =>
  typeof value === "object" &&
  value !== null &&
  "message" in value &&
  typeof (value as RpcLikeError).message === "string";

/**
 * Extracts a human-readable message from anything a catch block can see:
 * an `Error`, an RPC error object, a string, or something unexpected.
 * Never returns "[object Object]".
 */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRpcLikeError(cause)) return cause.message as string;
  if (typeof cause === "string") return cause;
  try {
    const json = JSON.stringify(cause);
    if (json && json !== "{}") return json;
  } catch {
    // Circular or non-serializable value: fall through to the last resort.
  }
  return String(cause);
}

/** Wraps `cause` as a real `Error`, extracting its message first. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(errorMessage(cause));
}
