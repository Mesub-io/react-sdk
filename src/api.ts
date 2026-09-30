import { MesubClientError } from './errors';
import { createSubscriptionsApi, type SubscriptionsApi } from './subscribe-api';
import type { ClientSession, WalletProof } from './types';

export const DEFAULT_API_URL = 'https://api.mesub.io';
// Every call gives up after this, so a hung request never holds the refresh lock.
export const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
    publishableKey: string;
    apiUrl?: string | undefined;
    fetch?: FetchLike | undefined;
}

/** The client auth routes of the Mesub API. */
export interface MesubApi {
    sendCode(email: string): Promise<void>;
    createSession(email: string, code: string): Promise<ClientSession>;
    walletChallenge(sessionToken: string, address: string): Promise<{ message: string }>;
    proveWallet(
        sessionToken: string,
        proof: { address: string; signature: string; label?: string },
    ): Promise<WalletProof>;
    refresh(refreshToken: string): Promise<ClientSession>;
    logout(refreshToken: string): Promise<void>;
    // The Subscribe button's routes, under /v1/client/subscriptions.
    subscriptions: SubscriptionsApi;
}

/** A POST under `prefix`, JSON in and out, with the key and an optional bearer. */
export type Post = <T>(path: string, body: unknown, bearer?: string) => Promise<T>;

export function createApiClient(options: ApiClientOptions): MesubApi {
    const post = createPost(options, '/v1/client/auth');

    return {
        sendCode: (email) => post('/code', { email }),
        createSession: (email, code) => post('/session', { email, code }),
        walletChallenge: (sessionToken, address) =>
            post('/wallet/challenge', { address }, sessionToken),
        proveWallet: (sessionToken, proof) => post('/wallet', proof, sessionToken),
        refresh: (refreshToken) => post('/refresh', { refreshToken }),
        logout: (refreshToken) => post('/logout', { refreshToken }),
        subscriptions: createSubscriptionsApi(createPost(options, '/v1/client/subscriptions')),
    };
}

function createPost(options: ApiClientOptions, prefix: string): Post {
    const base = `${(options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}${prefix}`;
    // Read at call time, so a fetch stubbed after the client is built is still used.
    const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    return async function post<T>(path: string, body: unknown, bearer?: string): Promise<T> {
        const headers: Record<string, string> = {
            'X-Mesub-Key': options.publishableKey,
            'Content-Type': 'application/json',
        };
        if (bearer) headers.Authorization = `Bearer ${bearer}`;

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Raced too, since a custom fetch may ignore the signal.
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const abort = new DOMException(TIMEOUT_MESSAGE, 'TimeoutError');
                reject(timedOut(abort));
                controller.abort(abort);
            }, REQUEST_TIMEOUT_MS);
        });

        async function send(): Promise<T> {
            let response: Response;
            try {
                response = await doFetch(`${base}${path}`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    // The API never sets cookies on these routes.
                    credentials: 'omit',
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) throw timedOut(controller.signal.reason);
                throw new MesubClientError('Could not reach the Mesub API', null, {
                    cause: error,
                });
            }

            if (!response.ok) {
                throw new MesubClientError(await errorMessage(response), response.status);
            }
            if (response.status === 204) return undefined as T;
            return (await response.json()) as T;
        }

        try {
            // The body is read inside the race: a hung body times out too.
            return await Promise.race([send(), deadline]);
        } finally {
            clearTimeout(timer);
        }
    };
}

const TIMEOUT_MESSAGE = `Mesub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`;

function timedOut(cause: unknown): MesubClientError {
    return new MesubClientError(TIMEOUT_MESSAGE, null, { cause });
}

// NestJS errors: `{ message: string | string[], error, statusCode }`.
async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { message?: unknown };
        if (Array.isArray(body.message)) return body.message.join('; ');
        if (typeof body.message === 'string') return body.message;
    } catch {
        // Not JSON: fall through.
    }
    return `Mesub API answered ${response.status}`;
}
