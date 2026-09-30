/** A failed call to the Mesub API. `status` is null when the request never got an answer. */
export class MesubClientError extends Error {
    override readonly name = 'MesubClientError';
    readonly status: number | null;

    constructor(message: string, status: number | null, options?: ErrorOptions) {
        super(message, options);
        this.status = status;
    }
}

/** What `login()` rejects with when the subscriber closes the sign-in. */
export class MesubSignInCancelledError extends Error {
    override readonly name = 'MesubSignInCancelledError';

    constructor() {
        super('Sign-in cancelled');
    }
}
