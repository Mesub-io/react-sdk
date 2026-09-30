import { vi } from 'vitest';
import type { MesubSession, MesubUser } from '../src/types';

export const user: MesubUser = {
    id: 'usr_1',
    email: 'ada@example.com',
    walletAddress: 'Wa11et1111111111111111111111111111111111111',
    walletVerifiedAt: '2026-09-30T10:00:00.000Z',
    lastSignedInAt: '2026-09-30T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
};

export const session: MesubSession = { user, refreshToken: 'rt_1', accessToken: 'at_1' };

export function json(status: number, body?: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
}

/** A fetch mock answering every call with `response`, and the calls it got. */
export function mockFetch(response: () => Response | Promise<Response> = () => json(204)) {
    return vi.fn((_input: string, _init: RequestInit) => Promise.resolve(response()));
}
