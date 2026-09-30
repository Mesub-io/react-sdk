import { getBase58Decoder } from '@solana/kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    MesubProvider,
    MesubSignInCancelledError,
    useMesub,
    type MesubState,
    type MesubUser,
} from '../src';
import { json, user } from './helpers';
import { registerWallet, unregisterWallets } from './wallets';

const BASE = 'http://api.test/v1/client/auth';
const newcomer: MesubUser = { ...user, walletAddress: null, walletVerifiedAt: null };
const CHALLENGE = 'Sign in to Mesub\nNonce: 42 é';

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

/** The API, one handler per route. A route with no handler fails the test. */
function api(handlers: Record<string, Handler>) {
    return vi.fn(async (url: string, init: RequestInit) => {
        const path = url.slice(BASE.length);
        const handler = handlers[path];
        if (!handler) throw new Error(`unexpected call to ${path}`);
        return handler(JSON.parse(init.body as string) as Record<string, unknown>);
    });
}

const routes = {
    code: (): Response => json(204),
    newSession: (): Response =>
        json(201, {
            user: newcomer,
            sessionToken: 'st_1',
            refreshToken: 'rt_1',
            accessToken: null,
        }),
    returningSession: (): Response =>
        json(201, { user, sessionToken: 'st_1', refreshToken: 'rt_1', accessToken: 'at_1' }),
    challenge: (): Response => json(201, { message: CHALLENGE }),
    proved: (): Response => json(201, { user, accessToken: 'at_2' }),
};

const newcomerRoutes = {
    '/code': routes.code,
    '/session': routes.newSession,
    '/wallet/challenge': routes.challenge,
    '/wallet': routes.proved,
};

function calls(fetch: ReturnType<typeof api>, path: string) {
    return fetch.mock.calls
        .filter(([url]) => url === `${BASE}${path}`)
        .map(([, init]) => ({
            body: JSON.parse(init.body as string) as unknown,
            headers: init.headers as Record<string, string>,
        }));
}

function setup(handlers: Record<string, Handler> = newcomerRoutes) {
    const fetch = api(handlers);
    let state!: MesubState;
    function Probe() {
        state = useMesub();
        return <p>merchant app</p>;
    }
    render(
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
            <Probe />
        </MesubProvider>,
    );

    let login!: Promise<MesubUser>;
    act(() => {
        login = state.login();
    });
    // Tests that never settle it must not report an unhandled rejection.
    login.catch(() => undefined);
    return { fetch, login, state: () => state };
}

const dialog = () => screen.getByRole('dialog');
const queryDialog = () => screen.queryByRole('dialog');
const step = () => dialog().getAttribute('data-mesub-step');
const error = () => within(dialog()).queryByRole('alert')?.textContent ?? null;

function type(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string | RegExp) {
    fireEvent.click(within(dialog()).getByRole('button', { name }));
}

async function toCode(email = 'ada@example.com') {
    type('Email', email);
    click('Send the code');
    await waitFor(() => expect(step()).toBe('code'));
}

async function toWallet() {
    await toCode();
    type('Code', '123456');
    click('Continue');
    await waitFor(() => expect(step()).toBe('wallet'));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

afterEach(() => unregisterWallets());

describe('opening', () => {
    it('renders nothing before login()', () => {
        render(
            <MesubProvider publishableKey="PUB_1">
                <p>merchant app</p>
            </MesubProvider>,
        );

        expect(queryDialog()).toBeNull();
    });

    it('opens on login() as a modal dialog at the email step', () => {
        setup();

        expect(dialog().tagName).toBe('DIALOG');
        expect(dialog().getAttribute('aria-modal')).toBe('true');
        expect(dialog().hasAttribute('data-mesub-dialog')).toBe(true);
        expect(dialog()).toHaveProperty('open', true);
        expect(step()).toBe('email');
        expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(screen.getByText('merchant app')).toBeTruthy();
    });

    it('is labelled by its heading and focuses the email field', () => {
        setup();

        expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    });

    it('carries no class names, only data-mesub-* attributes', () => {
        setup();

        expect(dialog().querySelectorAll('[class]')).toHaveLength(0);
        expect(dialog().querySelectorAll('[style]')).toHaveLength(0);
    });
});

describe('the email step', () => {
    it('sends the trimmed email and moves to the code step', async () => {
        const { fetch } = setup();

        await toCode('  ada@example.com ');

        expect(calls(fetch, '/code')).toEqual([
            { body: { email: 'ada@example.com' }, headers: expect.any(Object) },
        ]);
        expect(screen.getByText('We sent a 6-digit code to ada@example.com.')).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByLabelText('Code'));
    });

    it('disables the button while the code is sent', async () => {
        const answer = deferred<Response>();
        setup({ '/code': () => answer.promise });

        type('Email', 'ada@example.com');
        click('Send the code');

        await waitFor(() =>
            expect(within(dialog()).getByRole('button', { name: 'Send the code' })).toHaveProperty(
                'disabled',
                true,
            ),
        );
        await act(async () => answer.resolve(json(204)));
        await waitFor(() => expect(step()).toBe('code'));
    });

    it.each([
        [400, 'email must be an email address'],
        [403, 'Origin not allowed'],
        [429, 'ThrottlerException: Too Many Requests'],
    ])('shows the API message on %i and stays', async (status, message) => {
        setup({ '/code': () => json(status, { message, statusCode: status }) });

        type('Email', 'ada@example');
        click('Send the code');

        await waitFor(() => expect(error()).toBe(message));
        expect(step()).toBe('email');
        expect(within(dialog()).getByRole('button', { name: 'Send the code' })).toHaveProperty(
            'disabled',
            false,
        );
    });

    it('says so when the network fails', async () => {
        setup({ '/code': () => Promise.reject(new TypeError('Failed to fetch')) });

        type('Email', 'ada@example.com');
        click('Send the code');

        await waitFor(() => expect(error()).toBe('Could not reach the Mesub API'));
        expect(step()).toBe('email');
    });

    it('says so when Mesub does not answer within 15 seconds, and a retry goes through', async () => {
        let hang = true;
        setup({ '/code': () => (hang ? new Promise<never>(() => undefined) : json(204)) });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            type('Email', 'ada@example.com');
            click('Send the code');
            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(error()).toBe('Mesub did not answer within 15 seconds');
            expect(step()).toBe('email');
        } finally {
            vi.useRealTimers();
        }

        hang = false;
        click('Send the code');
        await waitFor(() => expect(step()).toBe('code'));
        expect(error()).toBeNull();
    });

    it('clears the error once a retry succeeds', async () => {
        let first = true;
        setup({
            '/code': () => {
                if (!first) return json(204);
                first = false;
                return json(429, { message: 'Too many codes' });
            },
        });

        type('Email', 'ada@example.com');
        click('Send the code');
        await waitFor(() => expect(error()).toBe('Too many codes'));

        click('Send the code');
        await waitFor(() => expect(step()).toBe('code'));
        expect(error()).toBeNull();
    });
});

describe('the code step', () => {
    it('trades the email and code for a session', async () => {
        const { fetch } = setup();
        await toWallet();

        expect(calls(fetch, '/session')[0]?.body).toEqual({
            email: 'ada@example.com',
            code: '123456',
        });
    });

    it('completes at once for a returning subscriber, with no wallet step', async () => {
        const { fetch, login, state } = setup({
            '/code': routes.code,
            '/session': routes.returningSession,
        });
        await toCode();

        type('Code', '123456');
        click('Continue');

        await expect(login).resolves.toEqual(user);
        await waitFor(() => expect(queryDialog()).toBeNull());
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(0);
        expect(state().user).toEqual(user);
        await expect(state().getAccessToken()).resolves.toBe('at_1');
    });

    it.each([
        [401, 'Wrong code. Enter the one we emailed you.'],
        [401, 'That code expired. Ask for a new one.'],
        [400, 'code must be six digits'],
        [403, 'Origin not allowed'],
    ])('shows the API message on %i and stays', async (status, message) => {
        const { login } = setup({
            '/code': routes.code,
            '/session': () => json(status, { message, statusCode: status }),
        });
        await toCode();

        type('Code', '000000');
        click('Continue');

        await waitFor(() => expect(error()).toBe(message));
        expect(step()).toBe('code');
        const settled = vi.fn();
        void login.then(settled, settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
    });

    it('sends the code again and says so', async () => {
        const { fetch } = setup();
        await toCode();

        click('Send the code again');

        await waitFor(() =>
            expect(within(dialog()).getByRole('status').textContent).toBe('We sent a new code.'),
        );
        expect(calls(fetch, '/code')).toHaveLength(2);
        expect(calls(fetch, '/code')[1]?.body).toEqual({ email: 'ada@example.com' });
        expect(step()).toBe('code');
    });

    it('shows why the code could not be sent again', async () => {
        let count = 0;
        setup({
            '/code': () =>
                ++count === 1 ? json(204) : json(429, { message: 'Too many codes asked for' }),
        });
        await toCode();

        click('Send the code again');

        await waitFor(() => expect(error()).toBe('Too many codes asked for'));
        expect(within(dialog()).queryByRole('status')).toBeNull();
    });

    it('goes back to the email step, keeping the email', async () => {
        setup();
        await toCode();

        click('Back');

        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email')).toHaveProperty('value', 'ada@example.com');
        expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    });

    it('drops the previous step error when going back', async () => {
        setup({
            '/code': routes.code,
            '/session': () => json(401, { message: 'Wrong code.' }),
        });
        await toCode();
        type('Code', '000000');
        click('Continue');
        await waitFor(() => expect(error()).toBe('Wrong code.'));

        click('Back');

        expect(error()).toBeNull();
    });
});

describe('the wallet step', () => {
    it('lists only the wallets that can connect and sign a message on Solana', async () => {
        registerWallet({ name: 'Phantom' });
        registerWallet({ name: 'No Sign', without: ['solana:signMessage'] });
        registerWallet({ name: 'No Connect', without: ['standard:connect'] });
        registerWallet({ name: 'Ethereum Only', chains: ['eip155:1'] });
        setup();

        await toWallet();

        const list = within(dialog()).getByRole('list');
        expect(list.hasAttribute('data-mesub-wallets')).toBe(true);
        expect(
            within(list)
                .getAllByRole('button')
                .map((button) => button.textContent),
        ).toEqual(['Phantom']);
        expect(within(list).getByRole('button').getAttribute('data-mesub-wallet')).toBe('Phantom');
        expect(document.activeElement).toBe(within(list).getByRole('button'));
    });

    it('says clearly when no wallet is installed', async () => {
        setup();

        await toWallet();

        expect(screen.getByText(/No Solana wallet found in this browser/)).toBeTruthy();
        expect(within(dialog()).queryByRole('list')).toBeNull();
    });

    it('lists a wallet installed while the step is open', async () => {
        setup();
        await toWallet();

        act(() => {
            registerWallet({ name: 'Solflare' });
        });

        expect(within(dialog()).getByRole('button', { name: 'Solflare' })).toBeTruthy();
    });

    it('connects, signs the challenge, proves the wallet and completes', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        const { fetch, login, state } = setup();
        await toWallet();

        click('Phantom');

        await expect(login).resolves.toEqual(user);
        expect(fake.connect).toHaveBeenCalledOnce();

        const [challenge] = calls(fetch, '/wallet/challenge');
        expect(challenge?.body).toEqual({ address: fake.account.address });
        expect(challenge?.headers.Authorization).toBe('Bearer st_1');

        // The challenge's UTF-8 bytes, signed with the connected account.
        expect(fake.signMessage).toHaveBeenCalledOnce();
        const input = fake.signMessage.mock.calls[0]![0]!;
        expect(input.account).toBe(fake.account);
        expect(new TextDecoder().decode(input.message)).toBe(CHALLENGE);

        const [proof] = calls(fetch, '/wallet');
        const signature = getBase58Decoder().decode(fake.signature);
        expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
        expect(proof?.body).toEqual({ address: fake.account.address, signature });
        expect(proof?.headers.Authorization).toBe('Bearer st_1');

        await waitFor(() => expect(queryDialog()).toBeNull());
        expect(state().user).toEqual(user);
        expect(state().wallet).toBe(user.walletAddress);
        await expect(state().getAccessToken()).resolves.toBe('at_2');
    });

    it('calls the API in order: code, session, challenge, proof', async () => {
        registerWallet({ name: 'Phantom' });
        const { fetch, login } = setup();
        await toWallet();

        click('Phantom');
        await login;

        expect(fetch.mock.calls.map(([url]) => url.slice(BASE.length))).toEqual([
            '/code',
            '/session',
            '/wallet/challenge',
            '/wallet',
        ]);
    });

    it('says it waits for the signature while the wallet asks', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        const signed = deferred<{ signedMessage: Uint8Array; signature: Uint8Array }[]>();
        fake.signMessage.mockImplementationOnce(() => signed.promise);
        const { login } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() =>
            expect(within(dialog()).getByRole('status').textContent).toBe(
                'Waiting for the signature in your wallet.',
            ),
        );
        expect(within(dialog()).getByRole('button', { name: 'Phantom' })).toHaveProperty(
            'disabled',
            true,
        );
        await act(async () =>
            signed.resolve([{ signedMessage: new Uint8Array(), signature: fake.signature }]),
        );
        await expect(login).resolves.toEqual(user);
    });

    // On a dApp the merchant may already be connected to this wallet on the
    // same origin: disconnecting would sign the subscriber out of it too.
    it('never disconnects a wallet the site already had', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        const { login } = setup();
        await toWallet();

        click('Phantom');
        await login;

        expect(fake.disconnect).not.toHaveBeenCalled();
        expect(fake.connect).toHaveBeenCalledOnce();
    });

    it('shows a refused signature and signs on a retry', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { fetch, login } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() =>
            expect(error()).toBe('Phantom did not sign. It said: User rejected the request.'),
        );
        expect(step()).toBe('wallet');
        expect(calls(fetch, '/wallet')).toHaveLength(0);

        click('Phantom');

        await expect(login).resolves.toEqual(user);
        expect(fake.signMessage).toHaveBeenCalledTimes(2);
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(2);
    });

    it('shows a wallet that did not connect', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.connect.mockRejectedValueOnce(new Error('closed'));
        const { fetch } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe('Phantom did not connect.'));
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(0);
        expect(within(dialog()).getByRole('button', { name: 'Phantom' })).toHaveProperty(
            'disabled',
            false,
        );
    });

    it('shows a wallet that shared no Solana account', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.connect.mockResolvedValueOnce({
            accounts: [{ ...fake.account, chains: ['eip155:1'] }],
        });
        setup();
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe('Phantom shared no Solana account.'));
    });

    it.each([
        ['/wallet', 409, 'That wallet belongs to another Mesub account.'],
        ['/wallet', 401, 'That signature is not from this wallet.'],
        ['/wallet/challenge', 401, 'Sign in again.'],
        ['/wallet/challenge', 403, 'Origin not allowed'],
    ])('shows the API message when %s answers %i', async (path, status, message) => {
        registerWallet({ name: 'Phantom' });
        const { login } = setup({
            ...newcomerRoutes,
            [path]: () => json(status, { message, statusCode: status }),
        });
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe(message));
        expect(step()).toBe('wallet');
        const settled = vi.fn();
        void login.then(settled, settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
    });

    it('says so when the network fails during the proof', async () => {
        registerWallet({ name: 'Phantom' });
        setup({
            ...newcomerRoutes,
            '/wallet': () => Promise.reject(new TypeError('Failed to fetch')),
        });
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe('Could not reach the Mesub API'));
    });

    it('says so when Mesub does not answer within 15 seconds during the proof', async () => {
        registerWallet({ name: 'Phantom' });
        setup({ ...newcomerRoutes, '/wallet': () => new Promise<never>(() => undefined) });
        await toWallet();

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            click('Phantom');
            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(error()).toBe('Mesub did not answer within 15 seconds');
            expect(step()).toBe('wallet');
        } finally {
            vi.useRealTimers();
        }
    });

    it('goes back to the email step, the code being spent', async () => {
        setup();
        await toWallet();

        click('Back');

        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email')).toHaveProperty('value', 'ada@example.com');
    });
});

describe('closing', () => {
    it('rejects login() with MesubSignInCancelledError from the close button', async () => {
        const { login, state } = setup();

        click('Close');

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        expect(queryDialog()).toBeNull();
        expect(state().user).toBeNull();
    });

    it('rejects login() on Escape', async () => {
        const { login } = setup();

        fireEvent.keyDown(screen.getByLabelText('Email'), { key: 'Escape' });

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        expect(queryDialog()).toBeNull();
    });

    it("rejects login() on the browser's own cancel", async () => {
        const { login } = setup();

        fireEvent(dialog(), new Event('cancel', { cancelable: true }));

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        expect(queryDialog()).toBeNull();
    });

    it('can be closed from every step', async () => {
        registerWallet({ name: 'Phantom' });
        const { login } = setup();
        await toWallet();

        click('Close');

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
    });

    it('ignores an answer that arrives after the close', async () => {
        const answer = deferred<Response>();
        const { login, state } = setup({
            '/code': routes.code,
            '/session': () => answer.promise,
        });
        await toCode();
        type('Code', '123456');
        click('Continue');

        click('Close');
        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        await act(async () => answer.resolve(routes.returningSession()));

        expect(state().user).toBeNull();
        expect(queryDialog()).toBeNull();
    });

    it('starts again from the email step on the next login()', async () => {
        const { login, state } = setup();
        await toCode();
        click('Close');
        await expect(login).rejects.toThrow('Sign-in cancelled');

        act(() => {
            void state()
                .login()
                .catch(() => undefined);
        });

        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email')).toHaveProperty('value', '');
    });
});
