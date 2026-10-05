import { getBase58Decoder } from '@solana/kit';
import { vi } from 'vitest';
import type { MesubPlan, MesubSubscription } from '../src';
import type { PreparedSubscription } from '../src/types';

/** Where the merchant mounted the routes, in every test. */
export const ENDPOINT = '/api/mesub';
export const WALLET = 'Wa11et1111111111111111111111111111111111111';
export const OTHER_WALLET = 'Other11111111111111111111111111111111111111';

export const TX_BYTES = Uint8Array.from([1, 2, 3]);
export const TX_BASE64 = btoa(String.fromCharCode(...TX_BYTES));
export const TERMS = 'Mesub terms\nPlan: pro\nNonce: 42';

export const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export const plan: MesubPlan = {
    slug: 'pro',
    name: 'Pro',
    description: 'Every report, every week.',
    project_name: 'Fraise',
    logo_url: 'https://cdn.test/fraise.png',
    amount: '2000000',
    amount_display: '2',
    decimals: 6,
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    period_hours: 72,
    network: 'devnet',
    status: 'active',
    available: true,
    ends_at: null,
};

export function subscription(overrides: Partial<MesubSubscription> = {}): MesubSubscription {
    return {
        id: 'sub_1',
        status: 'active',
        paused: false,
        end_reason: null,
        late_reason: null,
        access: true,
        payment_status: 'paid',
        plan: 'pro',
        wallet: WALLET,
        current_period_start: '2026-10-01T12:00:00.000Z',
        // Far ahead: a date that passes would turn a running one into one that is over.
        current_period_end: '2999-10-04T12:00:00.000Z',
        next_charge_at: '2999-10-04T12:00:00.000Z',
        next_retry_at: null,
        retry_deadline: null,
        access_until: '2999-10-04T12:00:00.000Z',
        created_at: '2026-10-01T12:00:00.000Z',
        confirmed_at: '2026-10-01T12:00:05.000Z',
        ...overrides,
    };
}

/** What `POST /subscriptions` answers, with terms good for ten minutes unless told otherwise. */
export function prepared(expiresInMs = 600_000): PreparedSubscription {
    return {
        subscription: { id: 'sub_1', status: 'pending' },
        transaction: TX_BASE64,
        last_valid_block_height: '100',
        costs: {
            rent: { subscription: '2039280', authority: '1500000', total: '3539280' },
            fee: { signatures: 2, per_signature: '5000', priority: '0', total: '10000' },
            total: '3549280',
        },
        terms: { message: TERMS, expires_at: new Date(Date.now() + expiresInMs).toISOString() },
    };
}

export function json(
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
        },
    });
}

/** A refusal as the routes write it. */
export function refusal(status: number, code: string, message: string, headers = {}): Response {
    return json(status, { error: { code, message } }, headers);
}

export type Handler = (body: Record<string, unknown> | null) => Response | Promise<Response>;

/**
 * The merchant's server, mocked to the contract of @mesub/node's routes: one
 * handler per `METHOD /path` under the endpoint. An unknown call throws.
 */
export function server(handlers: Record<string, Handler>) {
    return vi.fn(async (url: string, init: RequestInit) => {
        if (!url.startsWith(`${ENDPOINT}/`)) throw new Error(`call outside the endpoint: ${url}`);
        const key = `${init.method} ${url.slice(ENDPOINT.length)}`;
        const handler = handlers[key];
        if (!handler) throw new Error(`unexpected call to ${key}`);
        return handler(
            init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
        );
    });
}

export type Server = ReturnType<typeof server>;

/** The calls made, in order, as `METHOD /path`. */
export function made(fetch: Server): string[] {
    return fetch.mock.calls.map(([url, init]) => `${init.method} ${url.slice(ENDPOINT.length)}`);
}

/** The JSON bodies sent to one route, in order. */
export function bodies(fetch: Server, key: string): unknown[] {
    return fetch.mock.calls
        .filter(([url, init]) => `${init.method} ${url.slice(ENDPOINT.length)}` === key)
        .map(([, init]) => (init.body ? JSON.parse(init.body as string) : null));
}

/** A promise that never settles: a server that never answers. */
export const never = () => new Promise<Response>(() => undefined);
