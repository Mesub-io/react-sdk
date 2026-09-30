import { MesubClientError } from './errors';
import type { ClientSession, WalletProof } from './types';

export const DEFAULT_API_URL = 'https://api.mesub.io';

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
}

export function createApiClient(options: ApiClientOptions): MesubApi {
    const base = `${(options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/v1/client/auth`;
    // Read at call time, so a fetch stubbed after the client is built is still used.
    const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    async function post<T>(path: string, body: unknown, bearer?: string): Promise<T> {
        const headers: Record<string, string> = {
            'X-Mesub-Key': options.publishableKey,
            'Content-Type': 'application/json',
        };
        if (bearer) headers.Authorization = `Bearer ${bearer}`;

        let response: Response;
        try {
            response = await doFetch(`${base}${path}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                // The API never sets cookies on these routes.
                credentials: 'omit',
            });
        } catch (error) {
            throw new MesubClientError('Could not reach the Mesub API', null, { cause: error });
        }

        if (!response.ok) throw new MesubClientError(await errorMessage(response), response.status);
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
    }

    return {
        sendCode: (email) => post('/code', { email }),
        createSession: (email, code) => post('/session', { email, code }),
        walletChallenge: (sessionToken, address) =>
            post('/wallet/challenge', { address }, sessionToken),
        proveWallet: (sessionToken, proof) => post('/wallet', proof, sessionToken),
        refresh: (refreshToken) => post('/refresh', { refreshToken }),
        logout: (refreshToken) => post('/logout', { refreshToken }),
    };
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
