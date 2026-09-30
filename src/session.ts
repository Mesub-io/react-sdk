// Browser plumbing for the session: storage, the token cookie, the JWT expiry, the tab lock.

// Refresh this long before the access token expires.
export const REFRESH_MARGIN_MS = 60_000;
// A proactive refresh that could not reach the API tries again after this.
export const RETRY_MS = 30_000;
// What @mesub/node reads on page loads and server rendering.
export const COOKIE_NAME = 'mesub-token';
// Max-Age when the token's expiry cannot be read (the API issues one hour).
const FALLBACK_MAX_AGE = 3600;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function storageKey(publishableKey: string): string {
    return `mesub:session:${publishableKey}`;
}

export function lockName(publishableKey: string): string {
    return `mesub:refresh:${publishableKey}`;
}

/** The `exp` claim of a JWT, in milliseconds, or null when it cannot be read. */
export function expiresAt(token: string): number | null {
    const payload = token.split('.')[1];
    if (!payload) return null;
    try {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as {
            exp?: unknown;
        };
        return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    } catch {
        return null;
    }
}

/** The `document.cookie` line that writes the access token, or deletes it when null. */
export function tokenCookie(
    token: string | null,
    now: number,
    location: { protocol: string; hostname: string },
): string {
    const parts = token
        ? [`${COOKIE_NAME}=${token}`, `Max-Age=${maxAge(token, now)}`]
        : [`${COOKIE_NAME}=`, 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    parts.push('Path=/', 'SameSite=Lax');
    if (!(location.protocol === 'http:' && LOCAL_HOSTS.has(location.hostname))) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

function maxAge(token: string, now: number): number {
    const exp = expiresAt(token);
    if (exp === null) return FALLBACK_MAX_AGE;
    return Math.max(0, Math.floor((exp - now) / 1000));
}

export function writeTokenCookie(token: string | null): void {
    if (typeof document === 'undefined') return;
    document.cookie = tokenCookie(token, Date.now(), window.location);
}

/**
 * The refresh token in localStorage. `read()` is undefined when storage cannot
 * be used (blocked, full): the caller then relies on memory alone.
 */
export class TokenStore {
    private broken = false;

    constructor(readonly key: string) {}

    read(): string | null | undefined {
        const storage = this.storage();
        if (!storage) return undefined;
        try {
            return storage.getItem(this.key);
        } catch {
            return undefined;
        }
    }

    write(refreshToken: string): void {
        const storage = this.storage();
        if (!storage) return;
        try {
            storage.setItem(this.key, refreshToken);
        } catch {
            // A stale token left behind would be replayed: drop it, then use memory only.
            this.broken = true;
            try {
                storage.removeItem(this.key);
            } catch {
                // Nothing more to do.
            }
        }
    }

    clear(): void {
        try {
            this.storage()?.removeItem(this.key);
        } catch {
            // Blocked storage holds nothing to clear.
        }
    }

    private storage(): Storage | null {
        if (this.broken) return null;
        try {
            return globalThis.localStorage ?? null;
        } catch {
            return null;
        }
    }
}

/** Runs `task` under a lock shared by every tab of the origin, when the browser has one. */
export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request !== 'function') return task();
    return locks.request(name, task);
}
