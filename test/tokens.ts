import { vi } from 'vitest';
import { json, user } from './helpers';
import type { MesubUser } from '../src/types';

/** An unsigned JWT expiring at `expMs`: the SDK only reads the claim. */
export function jwt(expMs: number, sub = 'usr_1'): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'ES256' })}.${encode({ sub, exp: Math.floor(expMs / 1000) })}.sig`;
}

/** The mesub-token cookie, or null. */
export function readCookie(): string | null {
    const pair = document.cookie
        .split('; ')
        .find((part) => part.startsWith('mesub-token=') && part.length > 'mesub-token='.length);
    return pair ? pair.slice('mesub-token='.length) : null;
}

/** A Web Locks stand-in: one holder per name, the others wait their turn. */
export function installLocks() {
    const tails = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, task: () => Promise<unknown>) => {
        const run = (tails.get(name) ?? Promise.resolve()).then(task);
        tails.set(
            name,
            run.catch(() => undefined),
        );
        return run;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    return request;
}

export function removeLocks() {
    Reflect.deleteProperty(navigator, 'locks');
}

const BASE = 'http://api.test/v1/client/auth';

/**
 * The refresh routes as the API runs them: each token spends once, a spent or
 * ended one answers 401 and revokes every session (counted in `replays`).
 */
export function authServer(options: { user?: MesubUser } = {}) {
    let issued = 0;
    const live = new Set<string>();
    const spent = new Set<string>();
    const state = {
        replays: 0,
        // Set to make /refresh fail: 'network', or an HTTP status.
        failRefresh: null as 'network' | number | null,
        // Set to make /logout fail.
        failLogout: null as 'network' | number | null,
        // Holds /refresh until released.
        hold: null as Promise<void> | null,
        user: options.user ?? user,
        refreshed: [] as string[],
        loggedOut: [] as string[],
        live,
        issue(): { refreshToken: string; accessToken: string } {
            issued++;
            const refreshToken = `rt_${issued}`;
            live.add(refreshToken);
            return { refreshToken, accessToken: jwt(Date.now() + 3600_000, `at_${issued}`) };
        },
    };

    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const path = url.slice(BASE.length);
        const { refreshToken } = JSON.parse(init.body as string) as { refreshToken: string };

        if (path === '/refresh') {
            state.refreshed.push(refreshToken);
            if (state.hold) await state.hold;
            if (state.failRefresh === 'network') throw new TypeError('offline');
            if (typeof state.failRefresh === 'number') {
                return json(state.failRefresh, { message: 'failed' });
            }
            if (!live.has(refreshToken)) {
                if (spent.has(refreshToken)) {
                    state.replays++;
                    for (const token of live) spent.add(token);
                    live.clear();
                }
                return json(401, { message: 'Sign in again.' });
            }
            live.delete(refreshToken);
            spent.add(refreshToken);
            const next = state.issue();
            return json(201, { user: state.user, sessionToken: 'st', ...next });
        }

        if (path === '/logout') {
            state.loggedOut.push(refreshToken);
            if (state.failLogout === 'network') throw new TypeError('offline');
            if (typeof state.failLogout === 'number') return json(state.failLogout, {});
            if (live.delete(refreshToken)) spent.add(refreshToken);
            return json(204);
        }

        throw new Error(`unexpected call to ${path}`);
    });

    return { fetch, state };
}
