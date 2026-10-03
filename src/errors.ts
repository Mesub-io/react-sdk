/**
 * A call to the merchant's server that failed. `status` is null when nothing
 * answered (network, timeout); `code` is the server's own, as `@mesub/node` names it.
 */
export class MesubClientError extends Error {
    override readonly name = 'MesubClientError';
    readonly status: number | null;
    readonly code: string | null;
    // Seconds, from Retry-After on a 429.
    readonly retryAfter: number | null;

    constructor(
        message: string,
        status: number | null,
        code: string | null = null,
        options: ErrorOptions & { retryAfter?: number | null } = {},
    ) {
        super(message, options);
        this.status = status;
        this.code = code;
        this.retryAfter = options.retryAfter ?? null;
    }
}
