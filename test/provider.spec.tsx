import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useMesubInternal } from '../src/context';
import { MesubClientError, MesubProvider, MesubSignInCancelledError, useMesub } from '../src';
import { json, mockFetch, session, user } from './helpers';

function setup(fetch = mockFetch()) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test/" fetch={fetch}>
            {children}
        </MesubProvider>
    );
    const hook = renderHook(() => ({ state: useMesub(), internal: useMesubInternal() }), {
        wrapper,
    });
    return { fetch, ...hook };
}

async function signIn(result: ReturnType<typeof setup>['result']) {
    let login!: Promise<unknown>;
    act(() => {
        login = result.current.state.login();
    });
    act(() => result.current.internal.completeSignIn(session));
    await act(() => login);
}

describe('MesubProvider', () => {
    it('renders its children', () => {
        render(
            <MesubProvider publishableKey="PUB_1">
                <p>merchant app</p>
            </MesubProvider>,
        );

        expect(screen.getByText('merchant app')).toBeTruthy();
    });

    it('is ready after mount, with nobody signed in', async () => {
        const { result } = setup();

        await waitFor(() => expect(result.current.state.ready).toBe(true));
        expect(result.current.state.user).toBeNull();
        expect(result.current.state.wallet).toBeNull();
        expect(result.current.internal.signingIn).toBe(false);
    });

    it('builds the API client from its props', async () => {
        const { result, fetch } = setup();
        await act(() => result.current.internal.api.sendCode('ada@example.com'));

        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe('http://api.test/v1/client/auth/code');
        expect((init.headers as Record<string, string>)['X-Mesub-Key']).toBe('PUB_1');
    });
});

describe('useMesub', () => {
    it('throws outside the provider', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(() => renderHook(() => useMesub())).toThrow(/inside <MesubProvider>/);
            expect(() => renderHook(() => useMesubInternal())).toThrow(/inside <MesubProvider>/);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('login', () => {
    it('stays pending and marks a sign-in in progress until completeSignIn', async () => {
        const { result } = setup();
        const settled = vi.fn();

        act(() => {
            void result.current.state.login().then(settled, settled);
        });
        await Promise.resolve();

        expect(result.current.internal.signingIn).toBe(true);
        expect(settled).not.toHaveBeenCalled();
    });

    it('resolves with the user once the sign-in completes', async () => {
        const { result } = setup();
        let login!: Promise<unknown>;

        act(() => {
            login = result.current.state.login();
        });
        act(() => result.current.internal.completeSignIn(session));

        await expect(login).resolves.toEqual(user);
        expect(result.current.internal.signingIn).toBe(false);
        expect(result.current.state.user).toEqual(user);
        expect(result.current.state.wallet).toBe(user.walletAddress);
        expect(result.current.internal.session).toEqual(session);
    });

    it('rejects when the sign-in is cancelled', async () => {
        const { result } = setup();
        let login!: Promise<unknown>;

        act(() => {
            login = result.current.state.login();
        });
        act(() => result.current.internal.cancelSignIn());

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        expect(result.current.internal.signingIn).toBe(false);
        expect(result.current.state.user).toBeNull();
    });

    it('can start again after a cancel', async () => {
        const { result } = setup();
        let first!: Promise<unknown>;
        act(() => {
            first = result.current.state.login();
        });
        act(() => result.current.internal.cancelSignIn());
        await expect(first).rejects.toThrow('Sign-in cancelled');

        await signIn(result);
        expect(result.current.state.user).toEqual(user);
    });

    it('resolves at once when already signed in', async () => {
        const { result } = setup();
        await signIn(result);

        let again!: Promise<unknown>;
        act(() => {
            again = result.current.state.login();
        });

        await expect(again).resolves.toEqual(user);
        expect(result.current.internal.signingIn).toBe(false);
    });

    it('shares one sign-in between concurrent calls', async () => {
        const { result } = setup();
        let first!: Promise<unknown>;
        let second!: Promise<unknown>;

        act(() => {
            first = result.current.state.login();
            second = result.current.state.login();
        });
        expect(second).toBe(first);
        act(() => result.current.internal.completeSignIn(session));

        await expect(Promise.all([first, second])).resolves.toEqual([user, user]);
    });

    it('refuses to complete a sign-in without a proved wallet', () => {
        const { result } = setup();
        const noWallet = { ...session, accessToken: null };

        expect(() => result.current.internal.completeSignIn(noWallet)).toThrow(/proved wallet/);
        expect(result.current.state.user).toBeNull();
    });
});

describe('setSession', () => {
    it('replaces the session without touching a sign-in in progress', async () => {
        const { result } = setup();
        act(() => {
            void result.current.state.login().catch(() => undefined);
        });

        act(() => result.current.internal.setSession({ ...session, accessToken: 'at_2' }));

        expect(result.current.internal.signingIn).toBe(true);
        await expect(result.current.state.getAccessToken()).resolves.toBe('at_2');
    });

    it('signs out when set to null', async () => {
        const { result } = setup();
        await signIn(result);

        act(() => result.current.internal.setSession(null));

        expect(result.current.state.user).toBeNull();
        await expect(result.current.state.getAccessToken()).resolves.toBeNull();
    });
});

describe('getAccessToken', () => {
    it('is null, then the token once signed in', async () => {
        const { result } = setup();
        await expect(result.current.state.getAccessToken()).resolves.toBeNull();

        await signIn(result);

        await expect(result.current.state.getAccessToken()).resolves.toBe('at_1');
    });
});

describe('logout', () => {
    it('sends the refresh token to the API and clears the session', async () => {
        const { result, fetch } = setup(mockFetch(() => json(204)));
        await signIn(result);

        await act(() => result.current.state.logout());

        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe('http://api.test/v1/client/auth/logout');
        expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'rt_1' });
        expect(result.current.state.user).toBeNull();
        expect(result.current.state.wallet).toBeNull();
        await expect(result.current.state.getAccessToken()).resolves.toBeNull();
    });

    it('clears the session even when the network fails', async () => {
        const { result } = setup(mockFetch(() => Promise.reject(new TypeError('offline'))));
        await signIn(result);

        await act(() => result.current.state.logout());

        expect(result.current.state.user).toBeNull();
        expect(result.current.state.wallet).toBeNull();
    });

    it('clears the session even when the API refuses', async () => {
        const { result } = setup(mockFetch(() => json(401, { message: 'Unauthorized' })));
        await signIn(result);

        await expect(act(() => result.current.state.logout())).resolves.toBeUndefined();
        expect(result.current.state.user).toBeNull();
    });

    it('does not call the API when nobody is signed in', async () => {
        const { result, fetch } = setup();

        await act(() => result.current.state.logout());

        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('the package index', () => {
    it('exports the error class', () => {
        expect(new MesubClientError('x', 400)).toBeInstanceOf(Error);
    });
});
