import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MesubClientError, MesubProvider, useMesub } from '../src';
import { createApiClient } from '../src/api';
import { useMesubInternal } from '../src/context';
import { SessionKeeper } from '../src/keeper';
import type { MesubWallet } from '../src/wallets-api';
import { json, user } from './helpers';
import { authServer, installLocks, readCookie, removeLocks, walletToken } from './tokens';

const W1 = user.walletAddress!;
const W2 = 'Ledger22222222222222222222222222222222222222';
const API = 'http://api.test/v1/client/auth';

const linked: MesubWallet[] = [
    { address: W1, label: null, selected: true, plans: ['Pro'] },
    { address: W2, label: 'Ledger', selected: false, plans: [] },
];

type Handler = (
    body: Record<string, unknown> | null,
    init: RequestInit,
) => Response | Promise<Response>;

function server(overrides: Record<string, Handler> = {}) {
    const handlers: Record<string, Handler> = {
        'GET /wallets': () => json(200, { wallets: linked }),
        'POST /wallet/select': (body) =>
            json(201, { user, accessToken: walletToken(body!.address as string) }),
        'POST /logout': () => json(204),
        ...overrides,
    };
    return vi.fn(async (url: string, init: RequestInit) => {
        const key = `${init.method} ${url.slice(API.length)}`;
        const handler = handlers[key];
        if (!handler) throw new Error(`unexpected call to ${key}`);
        return handler(
            init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
            init,
        );
    });
}

function mount(fetch: ReturnType<typeof server>) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
            {children}
        </MesubProvider>
    );
    return renderHook(() => ({ state: useMesub(), internal: useMesubInternal() }), { wrapper });
}

type Hook = ReturnType<typeof mount>['result'];

function signIn(result: Hook, who = user, accessToken = walletToken(W1)) {
    act(() => {
        void result.current.state.login();
    });
    act(() =>
        result.current.internal.completeSignIn({ user: who, refreshToken: 'rt_1', accessToken }),
    );
}

function calls(fetch: ReturnType<typeof server>, key: string) {
    return fetch.mock.calls.filter(
        ([url, init]) => `${init.method} ${url.slice(API.length)}` === key,
    );
}

describe('useMesub().wallet', () => {
    it("is the access token's wallet, not the account's own", async () => {
        const { result } = mount(server());
        signIn(result, user, walletToken(W2));

        expect(result.current.state.wallet).toBe(W2);
        expect(result.current.state.user?.walletAddress).toBe(W1);
    });

    it("falls back to the account's wallet for a token without the claim", async () => {
        const { result } = mount(server());
        signIn(result, user, 'at_1');

        expect(result.current.state.wallet).toBe(W1);
    });
});

describe('useMesub().wallets', () => {
    it('is null until loadWallets() answers, and lists nothing on its own', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        signIn(result);
        await waitFor(() => expect(result.current.state.ready).toBe(true));

        expect(result.current.state.wallets).toBeNull();
        expect(calls(fetch, 'GET /wallets')).toHaveLength(0);
    });

    it('loads them with the access token and keeps them', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        const token = walletToken(W1);
        signIn(result, user, token);

        let loaded!: MesubWallet[];
        await act(async () => {
            loaded = await result.current.state.loadWallets();
        });

        expect(loaded).toEqual(linked);
        expect(result.current.state.wallets).toEqual(linked);
        const [, init] = calls(fetch, 'GET /wallets')[0]!;
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    });

    it('shares one request between concurrent calls', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        signIn(result);

        await act(async () => {
            await Promise.all([
                result.current.state.loadWallets(),
                result.current.state.loadWallets(),
            ]);
        });

        expect(calls(fetch, 'GET /wallets')).toHaveLength(1);
    });

    it('rejects with a 401, and calls nothing, when signed out', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        await waitFor(() => expect(result.current.state.ready).toBe(true));

        const error = await result.current.state.loadWallets().catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(MesubClientError);
        expect((error as MesubClientError).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects with the API error, and stays null', async () => {
        const fetch = server({ 'GET /wallets': () => json(503, { message: 'Down' }) });
        const { result } = mount(fetch);
        signIn(result);

        await expect(result.current.state.loadWallets()).rejects.toMatchObject({ status: 503 });
        expect(result.current.state.wallets).toBeNull();
    });

    it('is gone on logout, and never shows another account the last one', async () => {
        const { result } = mount(server());
        signIn(result);
        await act(() => result.current.state.loadWallets());
        await act(() => result.current.state.logout());

        expect(result.current.state.wallets).toBeNull();
        signIn(result, { ...user, id: 'usr_2' });
        expect(result.current.state.wallets).toBeNull();
    });
});

describe('useMesub().selectWallet', () => {
    it('switches the paying wallet with a new access token, on the same refresh token', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        signIn(result);
        await act(() => result.current.state.loadWallets());

        await act(() => result.current.state.selectWallet(W2));

        expect(calls(fetch, 'POST /wallet/select')).toHaveLength(1);
        expect(JSON.parse(calls(fetch, 'POST /wallet/select')[0]![1].body as string)).toEqual({
            address: W2,
        });
        expect(result.current.state.wallet).toBe(W2);
        // The dashboard's signing wallet is the account's: it never moves.
        expect(result.current.state.user?.walletAddress).toBe(W1);
        expect(result.current.internal.session?.refreshToken).toBe('rt_1');
        expect(localStorage.getItem('mesub:session:PUB_1')).toBe('rt_1');
        expect(readCookie()).toBe(walletToken(W2));
        expect(await result.current.state.getAccessToken()).toBe(walletToken(W2));
        expect(result.current.state.wallets?.map((wallet) => wallet.selected)).toEqual([
            false,
            true,
        ]);
    });

    it('works before the list was ever loaded', async () => {
        const { result } = mount(server());
        signIn(result);

        await act(() => result.current.state.selectWallet(W2));

        expect(result.current.state.wallet).toBe(W2);
        expect(result.current.state.wallets).toBeNull();
    });

    it('rejects a 404, and keeps the wallet that pays', async () => {
        const fetch = server({
            'POST /wallet/select': () =>
                json(404, { message: 'That wallet is not linked to your account.' }),
        });
        const { result } = mount(fetch);
        signIn(result);

        await expect(result.current.state.selectWallet(W2)).rejects.toMatchObject({
            status: 404,
            message: 'That wallet is not linked to your account.',
        });
        expect(result.current.state.wallet).toBe(W1);
        expect(readCookie()).toBe(walletToken(W1));
    });

    it('rejects with a 401 when signed out', async () => {
        const fetch = server();
        const { result } = mount(fetch);
        await waitFor(() => expect(result.current.state.ready).toBe(true));

        await expect(result.current.state.selectWallet(W2)).rejects.toMatchObject({ status: 401 });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('SessionKeeper.switchAccess', () => {
    afterEach(() => removeLocks());

    it('lets a refresh in flight land first, then switches on the rotated token', async () => {
        installLocks();
        const auth = authServer();
        const keeper = new SessionKeeper(
            createApiClient({
                publishableKey: 'PUB_1',
                apiUrl: 'http://api.test',
                fetch: auth.fetch,
            }),
            'PUB_1',
            () => undefined,
        );
        const stop = keeper.start();
        const first = auth.state.issue();
        keeper.set({ user, ...first });

        let release!: () => void;
        auth.state.hold = new Promise((resolve) => {
            release = resolve;
        });
        const refreshing = keeper.refresh();
        const switching = keeper.switchAccess(user, walletToken(W2));
        release();
        await refreshing;
        const switched = await switching;
        stop();

        // The rotated token is kept, not ended: the session stays alive.
        expect(switched?.refreshToken).toBe('rt_2');
        expect(switched?.accessToken).toBe(walletToken(W2));
        expect(auth.state.loggedOut).toEqual([]);
        expect(auth.state.live.has('rt_2')).toBe(true);
        expect(localStorage.getItem('mesub:session:PUB_1')).toBe('rt_2');
    });

    it('signs out instead when another tab signed out meanwhile', async () => {
        const auth = authServer();
        const onChange = vi.fn();
        const keeper = new SessionKeeper(
            createApiClient({
                publishableKey: 'PUB_1',
                apiUrl: 'http://api.test',
                fetch: auth.fetch,
            }),
            'PUB_1',
            onChange,
        );
        const stop = keeper.start();
        keeper.set({ user, ...auth.state.issue() });
        localStorage.removeItem('mesub:session:PUB_1');

        expect(await keeper.switchAccess(user, walletToken(W2))).toBeNull();
        stop();

        expect(keeper.session).toBeNull();
        expect(localStorage.getItem('mesub:session:PUB_1')).toBeNull();
        expect(localStorage.getItem('mesub:wallet:PUB_1')).toBeNull();
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('does nothing when signed out meanwhile', async () => {
        const auth = authServer();
        const onChange = vi.fn();
        const keeper = new SessionKeeper(
            createApiClient({
                publishableKey: 'PUB_1',
                apiUrl: 'http://api.test',
                fetch: auth.fetch,
            }),
            'PUB_1',
            onChange,
        );

        expect(await keeper.switchAccess(user, walletToken(W2))).toBeNull();
        expect(keeper.session).toBeNull();
        expect(readCookie()).toBeNull();
    });
});
