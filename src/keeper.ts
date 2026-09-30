import type { MesubApi } from './api';
import { MesubClientError } from './errors';
import {
    REFRESH_MARGIN_MS,
    RETRY_MS,
    TokenStore,
    expiresAt,
    lockName,
    storageKey,
    withLock,
    writeTokenCookie,
} from './session';
import type { MesubSession } from './types';

const noop = () => undefined;

/** 400 or 401 on refresh: the token is spent, expired or revoked. */
function isDead(error: unknown): boolean {
    return error instanceof MesubClientError && (error.status === 400 || error.status === 401);
}

/**
 * Keeps one session alive across reloads and tabs. localStorage holds the
 * refresh token and is the truth: a refresh always spends what it holds at
 * that moment, under a cross-tab lock, so no token is ever spent twice.
 */
export class SessionKeeper {
    session: MesubSession | null = null;
    private readonly store: TokenStore;
    private readonly lock: string;
    private inflight: Promise<MesubSession | null> | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    // Bumped when the session is replaced: a refresh started before must not win.
    private epoch = 0;
    private stopped = true;
    // The restore could not reach the API: try again when the browser is back online.
    private retryRestore = false;

    constructor(
        private readonly api: MesubApi,
        publishableKey: string,
        private readonly onChange: (session: MesubSession | null) => void,
    ) {
        this.store = new TokenStore(storageKey(publishableKey));
        this.lock = lockName(publishableKey);
    }

    /** Listens to other tabs and the network. Returns the matching stop. */
    start(): () => void {
        this.stopped = false;
        window.addEventListener('storage', this.onStorage);
        window.addEventListener('online', this.onOnline);
        this.schedule();
        return () => {
            this.stopped = true;
            window.removeEventListener('storage', this.onStorage);
            window.removeEventListener('online', this.onOnline);
            clearTimeout(this.timer);
        };
    }

    /** Signs the stored session back in, if any. Never throws. */
    async restore(): Promise<void> {
        if (this.session || !this.store.read()) return;
        try {
            await this.refresh();
        } catch {
            // Unreachable, not refused: the token stays for a later try.
            this.retryRestore = true;
        }
    }

    /** Replaces the session: persisted, written to the cookie, refreshed before it expires. */
    set(session: MesubSession | null): void {
        this.epoch++;
        this.apply(session);
    }

    /** One refresh at a time in this tab, and one per token across tabs. */
    refresh(): Promise<MesubSession | null> {
        this.inflight ??= withLock(this.lock, () => this.spend()).finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    async getAccessToken(): Promise<string | null> {
        // A restore or refresh in progress: its answer is the one to use.
        if (this.inflight) await this.inflight.catch(noop);
        const current = this.session;
        if (!current?.accessToken) return null;

        const exp = expiresAt(current.accessToken);
        if (exp === null || exp - Date.now() > REFRESH_MARGIN_MS) return current.accessToken;
        try {
            return (await this.refresh())?.accessToken ?? null;
        } catch (error) {
            // Unreachable API, but the token still has a few seconds.
            if (exp > Date.now()) return current.accessToken;
            throw error;
        }
    }

    /** Signs out at once, then ends the session server side. Never throws. */
    async logout(): Promise<void> {
        const current = this.session;
        const stored = this.store.read();
        this.epoch++;
        this.session = null;
        clearTimeout(this.timer);
        this.store.clear();
        writeTokenCookie(null);
        this.notify(null);

        // A refresh in flight sees the new epoch and ends the token it got.
        await this.inflight?.catch(noop);
        await withLock(this.lock, async () => {
            // Another tab may have rotated the token meanwhile: end the latest one.
            const token = this.store.read() || stored || current?.refreshToken;
            this.store.clear();
            writeTokenCookie(null);
            // Signed out locally whatever the API says: the token just expires.
            if (token) await this.api.logout(token).catch(noop);
        });
    }

    private async spend(): Promise<MesubSession | null> {
        const epoch = this.epoch;
        const stored = this.store.read();
        // Storage is shared by the tabs: spend what it holds, never an older copy.
        const token = stored === undefined ? this.session?.refreshToken : stored;
        if (!token) {
            // Another tab signed out.
            if (this.session) this.dropLocally();
            return null;
        }

        let next;
        try {
            next = await this.api.refresh(token);
        } catch (error) {
            if (epoch !== this.epoch) return this.session;
            if (!isDead(error)) throw error;
            // Spent, expired or revoked: sign in again.
            this.apply(null);
            return null;
        }

        const signedIn = next.accessToken !== null && next.user.walletAddress !== null;
        if (epoch !== this.epoch || !signedIn) {
            // Replaced or signed out meanwhile, or no wallet: end what we were handed.
            await this.api.logout(next.refreshToken).catch(noop);
            if (epoch === this.epoch) this.apply(null);
            return this.session;
        }

        const session: MesubSession = {
            user: next.user,
            refreshToken: next.refreshToken,
            accessToken: next.accessToken,
        };
        this.apply(session);
        return session;
    }

    private apply(session: MesubSession | null): void {
        // Written even after unmount: a stored token that was spent would be replayed.
        if (session) this.store.write(session.refreshToken);
        else this.store.clear();
        writeTokenCookie(session?.accessToken ?? null);
        this.session = session;
        this.schedule();
        this.notify(session);
    }

    // Signed out by another tab: storage and cookie are already cleared.
    private dropLocally(): void {
        this.epoch++;
        this.session = null;
        clearTimeout(this.timer);
        this.notify(null);
    }

    private notify(session: MesubSession | null): void {
        if (!this.stopped) this.onChange(session);
    }

    // The single timer: refresh a minute before the access token expires.
    private schedule(delay?: number): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const token = this.session?.accessToken;
        if (this.stopped || !token) return;
        const exp = expiresAt(token);
        if (delay === undefined && exp === null) return;
        const wait = delay ?? Math.max(0, (exp ?? 0) - REFRESH_MARGIN_MS - Date.now());
        this.timer = setTimeout(() => {
            // Only an unreachable API throws here: try again soon.
            this.refresh().catch(() => this.schedule(RETRY_MS));
        }, wait);
    }

    private readonly onStorage = (event: StorageEvent): void => {
        // A null key is localStorage.clear().
        if (event.key !== null && event.key !== this.store.key) return;
        const stored = this.store.read();
        if (stored === undefined || stored === this.session?.refreshToken) return;

        if (!stored) {
            if (this.session) this.dropLocally();
        } else if (this.session) {
            // Rotated by another tab: our access token is still good until it expires.
            this.session = { ...this.session, refreshToken: stored };
            this.notify(this.session);
        } else {
            // Signed in by another tab.
            this.refresh().catch(noop);
        }
    };

    private readonly onOnline = (): void => {
        if (!this.retryRestore || this.session) return;
        this.retryRestore = false;
        void this.restore();
    };
}
