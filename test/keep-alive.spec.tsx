import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { MesubClientError, MesubProvider, useMesub } from '../src';
import { useMesubInternal } from '../src/context';
import { user } from './helpers';
import { authServer, installLocks, jwt, readCookie, removeLocks } from './tokens';

const KEY = 'mesub:session:PUB_1';
const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);
const HOUR = 3600_000;

type Server = ReturnType<typeof authServer>;

function mount(server: Server, options: { strict?: boolean; publishableKey?: string } = {}) {
    const wrapper = ({ children }: { children: ReactNode }) => {
        const provider = (
            <MesubProvider
                publishableKey={options.publishableKey ?? 'PUB_1'}
                apiUrl="http://api.test"
                fetch={server.fetch}
            >
                {children}
            </MesubProvider>
        );
        return options.strict ? <StrictMode>{provider}</StrictMode> : provider;
    };
    return renderHook(() => ({ state: useMesub(), internal: useMesubInternal() }), { wrapper });
}

type Tab = ReturnType<typeof mount>;

/** Lets fetch answers, their bodies and React updates run to the end. */
async function settle() {
    await act(async () => {
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    });
}

async function advance(ms: number) {
    await act(() => vi.advanceTimersByTimeAsync(ms));
    await settle();
}

/** A token another tab or a previous page load left behind. */
function seed(server: Server): string {
    const { refreshToken } = server.state.issue();
    localStorage.setItem(KEY, refreshToken);
    return refreshToken;
}

/** What another tab's write looks like to this one. */
function storageEvent(key: string | null = KEY) {
    act(() => {
        window.dispatchEvent(
            new StorageEvent('storage', { key, newValue: localStorage.getItem(KEY) }),
        );
    });
}

function signIn(tab: Tab, server: Server) {
    const { refreshToken, accessToken } = server.state.issue();
    act(() => {
        void tab.result.current.state.login();
    });
    act(() => tab.result.current.internal.completeSignIn({ user, refreshToken, accessToken }));
    return { refreshToken, accessToken };
}

function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    removeLocks();
});

describe('restoring on mount', () => {
    it('is ready at once, without a call, when nothing is stored', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();

        expect(tab.result.current.state.ready).toBe(true);
        expect(tab.result.current.state.user).toBeNull();
        expect(server.fetch).not.toHaveBeenCalled();
    });

    it('signs the stored session back in, and is ready only once it answered', async () => {
        const server = authServer();
        const stored = seed(server);
        const gate = deferred();
        server.state.hold = gate.promise;

        const tab = mount(server);
        await settle();
        expect(tab.result.current.state.ready).toBe(false);
        expect(tab.result.current.state.user).toBeNull();

        gate.release();
        await settle();

        expect(server.state.refreshed).toEqual([stored]);
        expect(tab.result.current.state.ready).toBe(true);
        expect(tab.result.current.state.user).toEqual(user);
        expect(tab.result.current.state.wallet).toBe(user.walletAddress);
    });

    it('stores the rotated refresh token and writes the access token cookie', async () => {
        const server = authServer();
        seed(server);
        const tab = mount(server);
        await settle();

        const session = tab.result.current.internal.session!;
        expect(session.refreshToken).toBe('rt_2');
        expect(localStorage.getItem(KEY)).toBe('rt_2');
        expect(readCookie()).toBe(session.accessToken);
        await expect(tab.result.current.state.getAccessToken()).resolves.toBe(session.accessToken);
    });

    it.each([401, 400])('clears storage and stays signed out on %i', async (status) => {
        const server = authServer();
        seed(server);
        server.state.failRefresh = status;
        const tab = mount(server);
        await settle();

        expect(tab.result.current.state.ready).toBe(true);
        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(readCookie()).toBeNull();
    });

    it('clears a token the API no longer knows', async () => {
        const server = authServer();
        localStorage.setItem(KEY, 'rt_unknown');
        const tab = mount(server);
        await settle();

        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it.each([
        ['the network fails', 'network' as const],
        ['the API errs', 500],
        ['the origin is refused', 403],
    ])('keeps the stored token, signed out, when %s', async (_, failure) => {
        const server = authServer();
        const stored = seed(server);
        server.state.failRefresh = failure;
        const tab = mount(server);
        await settle();

        expect(tab.result.current.state.ready).toBe(true);
        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBe(stored);
    });

    it('tries again when the browser is back online', async () => {
        const server = authServer();
        seed(server);
        server.state.failRefresh = 'network';
        const tab = mount(server);
        await settle();

        server.state.failRefresh = null;
        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        await settle();

        expect(tab.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
    });

    it('restores once under StrictMode', async () => {
        const server = authServer();
        seed(server);
        const tab = mount(server, { strict: true });
        await settle();

        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(tab.result.current.state.user).toEqual(user);
        expect(server.state.replays).toBe(0);
    });

    it('keys the storage by publishable key', async () => {
        const server = authServer();
        seed(server);
        const tab = mount(server, { publishableKey: 'PUB_2' });
        await settle();

        expect(server.fetch).not.toHaveBeenCalled();
        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBe('rt_1');
    });

    it('stays signed out, and ends the token, when the account has no wallet', async () => {
        const server = authServer({ user: { ...user, walletAddress: null } });
        seed(server);
        const tab = mount(server);
        await settle();

        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(server.state.loggedOut).toEqual(['rt_2']);
    });
});

describe('refreshing before the access token expires', () => {
    it('refreshes a minute before exp, then again an hour later with the rotated token', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);

        await advance(HOUR - 61_000);
        expect(server.state.refreshed).toEqual([]);

        await advance(1_000);
        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
        expect(readCookie()).toBe(tab.result.current.internal.session!.accessToken);

        await advance(HOUR - 60_000);
        expect(server.state.refreshed).toEqual(['rt_1', 'rt_2']);
        expect(localStorage.getItem(KEY)).toBe('rt_3');
        expect(server.state.replays).toBe(0);
    });

    it('keeps a single timer when the session is replaced', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        const { refreshToken, accessToken } = server.state.issue();
        act(() => tab.result.current.internal.setSession({ user, refreshToken, accessToken }));

        await advance(HOUR);

        expect(server.state.refreshed).toEqual(['rt_2']);
    });

    it('tries again 30 seconds after a network failure, and keeps the session meanwhile', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        server.state.failRefresh = 'network';

        await advance(HOUR - 60_000);
        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(tab.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_1');

        server.state.failRefresh = null;
        await advance(30_000);
        expect(server.state.refreshed).toEqual(['rt_1', 'rt_1']);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
    });

    it('signs out when the refresh is refused', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        server.state.failRefresh = 401;

        await advance(HOUR);

        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(readCookie()).toBeNull();
        await advance(HOUR);
        expect(server.state.refreshed).toEqual(['rt_1']);
    });

    it('stops its timer on unmount', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);

        tab.unmount();
        await advance(2 * HOUR);

        expect(server.fetch).not.toHaveBeenCalled();
    });

    it('still stores the rotated token when unmounted mid-refresh', async () => {
        const server = authServer();
        seed(server);
        const gate = deferred();
        server.state.hold = gate.promise;
        const tab = mount(server);
        await settle();

        tab.unmount();
        gate.release();
        await settle();

        expect(localStorage.getItem(KEY)).toBe('rt_2');
    });
});

describe('getAccessToken', () => {
    it('returns a fresh token without calling the API', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { accessToken } = signIn(tab, server);

        await expect(tab.result.current.state.getAccessToken()).resolves.toBe(accessToken);
        expect(server.fetch).not.toHaveBeenCalled();
    });

    it('refreshes an expired token first', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { refreshToken, accessToken } = server.state.issue();
        vi.setSystemTime(NOW + 2 * HOUR);
        const expired = jwt(NOW + HOUR);
        act(() =>
            tab.result.current.internal.setSession({ user, refreshToken, accessToken: expired }),
        );
        await settle();

        let token!: string | null;
        await act(async () => {
            token = await tab.result.current.state.getAccessToken();
        });

        expect(server.state.refreshed).toEqual([refreshToken]);
        expect(token).not.toBe(expired);
        expect(token).not.toBe(accessToken);
        expect(token).toBe(tab.result.current.internal.session!.accessToken);
        expect(server.state.replays).toBe(0);
    });

    it('refreshes a token that expires within the minute', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { accessToken } = signIn(tab, server);
        vi.setSystemTime(NOW + HOUR - 30_000);

        let token!: string | null;
        await act(async () => {
            token = await tab.result.current.state.getAccessToken();
        });

        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(token).not.toBe(accessToken);
    });

    it('shares one refresh between concurrent callers', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        vi.setSystemTime(NOW + HOUR + 1);

        let tokens!: (string | null)[];
        await act(async () => {
            const { getAccessToken } = tab.result.current.state;
            tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
        });

        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(new Set(tokens).size).toBe(1);
        expect(tokens[0]).toBe(tab.result.current.internal.session!.accessToken);
        expect(server.state.replays).toBe(0);
    });

    it('waits for the restore in progress', async () => {
        const server = authServer();
        seed(server);
        const gate = deferred();
        server.state.hold = gate.promise;
        const tab = mount(server);
        await settle();

        const token = tab.result.current.state.getAccessToken();
        gate.release();
        await settle();

        await expect(token).resolves.toBe(tab.result.current.internal.session!.accessToken);
        expect(server.state.refreshed).toEqual(['rt_1']);
    });

    it('is null once a refresh is refused', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        vi.setSystemTime(NOW + HOUR + 1);
        server.state.failRefresh = 401;

        await act(async () => {
            await expect(tab.result.current.state.getAccessToken()).resolves.toBeNull();
        });
        expect(tab.result.current.state.user).toBeNull();
    });

    it('throws MesubClientError when the API is unreachable and the token expired', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        vi.setSystemTime(NOW + HOUR + 1);
        server.state.failRefresh = 'network';

        await act(async () => {
            await expect(tab.result.current.state.getAccessToken()).rejects.toBeInstanceOf(
                MesubClientError,
            );
        });
        expect(tab.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_1');
    });

    it('returns the token still valid when the API is unreachable', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { accessToken } = signIn(tab, server);
        vi.setSystemTime(NOW + HOUR - 30_000);
        server.state.failRefresh = 'network';

        await act(async () => {
            await expect(tab.result.current.state.getAccessToken()).resolves.toBe(accessToken);
        });
    });
});

describe('the cookie', () => {
    it('is written on sign-in, for the token life, and cleared on logout', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const writes: string[] = [];
        const descriptor = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(document),
            'cookie',
        );
        const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
            writes.push(value);
            descriptor?.set?.call(document, value);
        });

        const { accessToken } = signIn(tab, server);
        await act(() => tab.result.current.state.logout());
        spy.mockRestore();

        // happy-dom runs on http://localhost:3000: no Secure there.
        expect(writes[0]).toBe(`mesub-token=${accessToken}; Max-Age=3600; Path=/; SameSite=Lax`);
        expect(writes.at(-1)).toMatch(/^mesub-token=; Max-Age=0; Expires=Thu, 01 Jan 1970/);
        expect(readCookie()).toBeNull();
    });
});

describe('completeSignIn', () => {
    it('persists the refresh token, so a reload restores it', async () => {
        const server = authServer();
        const first = mount(server);
        await settle();
        const { refreshToken, accessToken } = signIn(first, server);

        expect(localStorage.getItem(KEY)).toBe(refreshToken);
        expect(readCookie()).toBe(accessToken);

        first.unmount();
        const reloaded = mount(server);
        await settle();

        expect(server.state.refreshed).toEqual([refreshToken]);
        expect(reloaded.result.current.state.user).toEqual(user);
    });
});

describe('logout', () => {
    it('clears storage and cookie, and ends the latest stored token', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        // Another tab rotated it meanwhile.
        const rotated = server.state.issue().refreshToken;
        localStorage.setItem(KEY, rotated);

        await act(() => tab.result.current.state.logout());

        expect(server.state.loggedOut).toEqual([rotated]);
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(readCookie()).toBeNull();
        expect(tab.result.current.state.user).toBeNull();
    });

    it.each([
        ['the network fails', 'network' as const],
        ['the API refuses', 401],
    ])('clears everything even when %s', async (_, failure) => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        server.state.failLogout = failure;

        await expect(act(() => tab.result.current.state.logout())).resolves.toBeUndefined();

        expect(localStorage.getItem(KEY)).toBeNull();
        expect(readCookie()).toBeNull();
        expect(tab.result.current.state.user).toBeNull();
    });

    it('stops the refresh timer', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        await act(() => tab.result.current.state.logout());

        await advance(2 * HOUR);

        expect(server.state.refreshed).toEqual([]);
    });

    it('wins over a refresh in flight: the rotated token is ended, not stored', async () => {
        const server = authServer();
        seed(server);
        const gate = deferred();
        server.state.hold = gate.promise;
        const tab = mount(server);
        await settle();
        // A restore is waiting on the API.

        let done!: Promise<void>;
        act(() => {
            done = tab.result.current.state.logout();
        });
        gate.release();
        await settle();
        await act(() => done);

        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(readCookie()).toBeNull();
        expect(server.state.loggedOut).toContain('rt_2');
        expect(server.state.live.size).toBe(0);
        expect(server.state.replays).toBe(0);
    });
});

describe('several tabs', () => {
    it('adopts a token another tab rotated, and spends that one next', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { accessToken } = signIn(tab, server);
        // The other tab spent rt_1 and stored rt_2.
        server.state.live.delete('rt_1');
        const rotated = server.state.issue().refreshToken;
        localStorage.setItem(KEY, rotated);
        storageEvent();

        expect(tab.result.current.internal.session!.refreshToken).toBe(rotated);
        expect(tab.result.current.internal.session!.accessToken).toBe(accessToken);

        await advance(HOUR);
        expect(server.state.refreshed).toEqual([rotated]);
        expect(server.state.replays).toBe(0);
    });

    it('spends the stored token even without the event', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        server.state.live.delete('rt_1');
        const rotated = server.state.issue().refreshToken;
        localStorage.setItem(KEY, rotated);

        await advance(HOUR);

        expect(server.state.refreshed).toEqual([rotated]);
        expect(tab.result.current.state.user).toEqual(user);
    });

    it('signs out, without a call, when another tab signed out', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        localStorage.removeItem(KEY);
        storageEvent();

        expect(tab.result.current.state.user).toBeNull();
        await advance(2 * HOUR);
        expect(server.fetch).not.toHaveBeenCalled();
    });

    it('signs out on localStorage.clear() elsewhere', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        localStorage.clear();
        storageEvent(null);

        expect(tab.result.current.state.user).toBeNull();
    });

    it('ignores other keys', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        const { refreshToken } = signIn(tab, server);
        localStorage.setItem('other', 'x');
        storageEvent('other');

        expect(tab.result.current.internal.session!.refreshToken).toBe(refreshToken);
    });

    it('signs in when another tab did', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        seed(server);
        storageEvent();
        await settle();

        expect(tab.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
    });

    it('with Web Locks, two tabs refreshing at once spend each token once', async () => {
        const request = installLocks();
        const server = authServer();
        seed(server);
        const a = mount(server);
        const b = mount(server);
        await settle();

        // Both restored, one after the other, each with the token the other stored.
        expect(server.state.refreshed).toEqual(['rt_1', 'rt_2']);
        expect(request).toHaveBeenCalledWith('mesub:refresh:PUB_1', expect.any(Function));

        // Both timers fire in the same instant.
        await advance(HOUR);
        expect(server.state.refreshed).toEqual(['rt_1', 'rt_2', 'rt_3', 'rt_4']);
        expect(localStorage.getItem(KEY)).toBe('rt_5');
        expect(a.result.current.state.user).toEqual(user);
        expect(b.result.current.state.user).toEqual(user);

        // And concurrent callers in both tabs, all past exp.
        vi.setSystemTime(Date.now() + HOUR);
        await act(async () => {
            await Promise.all([
                a.result.current.state.getAccessToken(),
                a.result.current.state.getAccessToken(),
                b.result.current.state.getAccessToken(),
            ]);
        });
        expect(new Set(server.state.refreshed).size).toBe(server.state.refreshed.length);
        expect(server.state.replays).toBe(0);
    });

    it('with Web Locks, a logout in one tab never lets the other replay', async () => {
        installLocks();
        const server = authServer();
        seed(server);
        const a = mount(server);
        const b = mount(server);
        await settle();

        await act(() => a.result.current.state.logout());
        // b missed the event: its timer still fires.
        await advance(HOUR);

        expect(b.result.current.state.user).toBeNull();
        expect(server.state.replays).toBe(0);
    });
});

describe('a refresh that hangs', () => {
    it('restores later: the token stays, signed out, ready after 15 seconds', async () => {
        const server = authServer();
        const stored = seed(server);
        // Never released: the API took the request and never answered.
        server.state.hold = deferred().promise;
        const tab = mount(server);
        await settle();

        await advance(14_999);
        expect(tab.result.current.state.ready).toBe(false);

        await advance(1);
        expect(tab.result.current.state.ready).toBe(true);
        expect(tab.result.current.state.user).toBeNull();
        expect(localStorage.getItem(KEY)).toBe(stored);

        server.state.hold = null;
        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        await settle();
        expect(tab.result.current.state.user).toEqual(user);
        expect(server.state.refreshed).toEqual([stored, stored]);
        expect(server.state.replays).toBe(0);
    });

    it('keeps the session, then the retry 30 seconds later goes through', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        server.state.hold = deferred().promise;

        await advance(HOUR - 60_000 + 15_000);
        expect(server.state.refreshed).toEqual(['rt_1']);
        expect(tab.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_1');
        expect(readCookie()).not.toBeNull();

        server.state.hold = null;
        await advance(30_000);
        expect(server.state.refreshed).toEqual(['rt_1', 'rt_1']);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
        expect(tab.result.current.state.user).toEqual(user);
    });

    it('lets getAccessToken reject with the timeout once the token expired', async () => {
        const server = authServer();
        const tab = mount(server);
        await settle();
        signIn(tab, server);
        vi.setSystemTime(Date.now() + HOUR);
        server.state.hold = deferred().promise;

        let failure: unknown;
        const pending = tab.result.current.state.getAccessToken().catch((error: unknown) => {
            failure = error;
        });
        await advance(15_000);
        await act(() => pending);

        expect(failure).toBeInstanceOf(MesubClientError);
        expect((failure as MesubClientError).status).toBeNull();
        expect((failure as MesubClientError).message).toBe(
            'Mesub did not answer within 15 seconds',
        );
        expect(localStorage.getItem(KEY)).toBe('rt_1');
    });

    it('with Web Locks, releases the lock so another tab can refresh', async () => {
        const request = installLocks();
        const server = authServer();
        const stored = seed(server);
        server.state.hold = deferred().promise;
        const a = mount(server);
        await settle();
        // Only a's refresh reached the API: it holds the lock, b waits for it.
        server.state.hold = null;
        const b = mount(server);
        await settle();
        expect(server.state.refreshed).toEqual([stored]);
        expect(request).toHaveBeenCalledTimes(2);

        await advance(15_000);

        expect(server.state.refreshed).toEqual([stored, stored]);
        expect(b.result.current.state.user).toEqual(user);
        expect(localStorage.getItem(KEY)).toBe('rt_2');
        expect(a.result.current.state.ready).toBe(true);
        expect(server.state.replays).toBe(0);
    });
});
