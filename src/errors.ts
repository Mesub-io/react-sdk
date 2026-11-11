/**
 * A call to the merchant's server that failed. `status` is null when nothing
 * answered (network, timeout); `code` is the server's own, as `@mesub/node` names it.
 */
export class MesubClientError extends Error {
    override readonly name = 'MesubClientError';
    readonly status: number | null;
    readonly code: string | null;
    // Seconds, from Retry-After: on a 429, and on a 503 `unavailable` (Mesub-io/backend#505).
    readonly retryAfter: number | null;
    // What the refusal says beside its code and message: `subscription_id` on a `subscription_cancelled`.
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        message: string,
        status: number | null,
        code: string | null = null,
        options: ErrorOptions & {
            retryAfter?: number | null;
            details?: Record<string, unknown>;
        } = {},
    ) {
        super(message, options);
        this.status = status;
        this.code = code;
        this.retryAfter = options.retryAfter ?? null;
        this.details = options.details ?? {};
    }
}
