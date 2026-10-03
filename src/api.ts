import { MesubClientError } from './errors';
import type {
    MesubAction,
    MesubPlan,
    MesubSubscription,
    PreparedSubscription,
    Settled,
    WalletTransaction,
} from './types';

// Reads and builds answer at once.
export const REQUEST_TIMEOUT_MS = 15_000;
// Submit and the confirms wait for the chain: about a minute.
export const CHAIN_TIMEOUT_MS = 90_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
    // Where the merchant mounted the routes of @mesub/node: "/api/mesub".
    endpoint: string;
    fetch?: FetchLike | undefined;
}

/** The routes `@mesub/node` mounts on the merchant's server. Nothing here reaches Mesub. */
export interface MesubApi {
    plan(slug: string): Promise<MesubPlan>;
    subscriptions(): Promise<MesubSubscription[]>;
    prepare(plan: string, wallet: string): Promise<PreparedSubscription>;
    submit(id: string, signed: { transaction: string; terms_signature: string }): Promise<Settled>;
    build(action: MesubAction, id: string): Promise<WalletTransaction>;
    confirm(action: MesubAction, id: string, signature: string): Promise<Settled>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function createApi(options: ApiOptions): MesubApi {
    const base = options.endpoint.replace(/\/+$/, '');
    // Read at call time, so a fetch stubbed after the client is built is still used.
    const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    async function request(
        method: 'GET' | 'POST',
        path: string,
        body: unknown,
        timeout: number,
    ): Promise<Record<string, unknown>> {
        const headers: Record<string, string> = { Accept: 'application/json' };
        // The routes refuse a POST that is not JSON, even one with nothing to say.
        if (method === 'POST') headers['Content-Type'] = 'application/json';

        const late = `No answer within ${timeout / 1000} seconds.`;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Raced too, since a custom fetch may ignore the signal.
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new MesubClientError(late, null, 'timeout'));
                controller.abort();
            }, timeout);
        });

        async function send(): Promise<Record<string, unknown>> {
            let response: Response;
            try {
                response = await doFetch(`${base}${path}`, {
                    method,
                    headers,
                    ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
                    // The merchant's own session cookie says who is asking.
                    credentials: 'include',
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) throw new MesubClientError(late, null, 'timeout');
                throw new MesubClientError('Could not reach the server.', null, 'network', {
                    cause: error,
                });
            }

            let answer: unknown;
            try {
                answer = await response.json();
            } catch {
                answer = undefined;
            }

            if (!response.ok) throw refusal(response, answer);
            if (!isObject(answer)) {
                // A page instead of JSON: the routes are not mounted at `endpoint`.
                throw new MesubClientError(
                    `${base}${path} did not answer as the @mesub/node routes do.`,
                    response.status,
                    'bad_response',
                );
            }
            return answer;
        }

        try {
            // The body is read inside the race: a hung body times out too.
            return await Promise.race([send(), deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    const at = (id: string) => `/subscriptions/${encodeURIComponent(id)}`;

    return {
        plan: async (slug) =>
            (await request(
                'GET',
                `/plans/${encodeURIComponent(slug)}`,
                undefined,
                REQUEST_TIMEOUT_MS,
            )) as unknown as MesubPlan,
        subscriptions: async () => {
            const answer = await request('GET', '/subscriptions', undefined, REQUEST_TIMEOUT_MS);
            return Array.isArray(answer.subscriptions)
                ? (answer.subscriptions as MesubSubscription[])
                : [];
        },
        prepare: async (plan, wallet) =>
            (await request(
                'POST',
                '/subscriptions',
                { plan, wallet },
                REQUEST_TIMEOUT_MS,
            )) as unknown as PreparedSubscription,
        submit: async (id, signed) =>
            (await request(
                'POST',
                `${at(id)}/submit`,
                { transaction: signed.transaction, terms_signature: signed.terms_signature },
                CHAIN_TIMEOUT_MS,
            )) as unknown as Settled,
        build: async (action, id) =>
            (await request(
                'POST',
                `${at(id)}/${action}`,
                {},
                REQUEST_TIMEOUT_MS,
            )) as unknown as WalletTransaction,
        confirm: async (action, id, signature) =>
            (await request(
                'POST',
                `${at(id)}/${action}/confirm`,
                { signature },
                CHAIN_TIMEOUT_MS,
            )) as unknown as Settled,
    };
}

/** `{ error: { code, message } }`, as the routes refuse. */
function refusal(response: Response, answer: unknown): MesubClientError {
    const error = isObject(answer) && isObject(answer.error) ? answer.error : null;
    const message =
        typeof error?.message === 'string' && error.message !== ''
            ? error.message
            : `The server answered ${response.status}.`;
    const seconds = Number(response.headers.get('Retry-After'));

    return new MesubClientError(
        message,
        response.status,
        typeof error?.code === 'string' ? error.code : null,
        { retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : null },
    );
}

/** Nothing answered: the network failed or the wait ran out. */
export function unreachable(error: unknown): boolean {
    return error instanceof MesubClientError && error.status === null;
}

/** The merchant's server says nobody is signed in on its site. */
export function signedOut(error: unknown): boolean {
    return error instanceof MesubClientError && error.status === 401;
}
