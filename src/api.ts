import { MesubClientError } from './errors';
import type {
    MesubAction,
    MesubPayment,
    MesubPlan,
    MesubSubscription,
    MesubSubscriptionDetail,
    MesubUpcoming,
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
    // One of them with its latest charges.
    subscription(id: string): Promise<MesubSubscriptionDetail>;
    prepare(plan: string, wallet: string): Promise<PreparedSubscription>;
    submit(id: string, signed: { transaction: string; terms_signature: string }): Promise<Settled>;
    build(action: MesubAction, id: string): Promise<WalletTransaction>;
    confirm(action: MesubAction, id: string, signature: string): Promise<Settled>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fewest charges a server lists when it lists them all: under it, the list is whole. */
const LISTED_AT_MOST = 5;

/**
 * What was paid since the subscription began. `paid` is the server's own
 * total. A server that predates it only sums the charges it lists
 * (`listed_paid`): that is the total only while the list is whole.
 */
function paidOf(answer: Record<string, unknown>): MesubSubscriptionDetail['paid'] {
    const read = (value: unknown) =>
        isObject(value) && typeof value.count === 'number'
            ? { count: value.count, amount: typeof value.amount === 'string' ? value.amount : null }
            : null;
    const total = read(answer.paid);
    if (total) return total;

    const whole = Array.isArray(answer.payments) && answer.payments.length < LISTED_AT_MOST;
    return whole ? read(answer.listed_paid) : null;
}

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
        subscription: async (id) => {
            const answer = await request('GET', at(id), undefined, REQUEST_TIMEOUT_MS);
            return {
                subscription: answer.subscription as MesubSubscription,
                upcoming: Array.isArray(answer.upcoming)
                    ? (answer.upcoming as MesubUpcoming[])
                    : [],
                payments: Array.isArray(answer.payments)
                    ? (answer.payments as MesubPayment[])
                    : null,
                paid: paidOf(answer),
            };
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
