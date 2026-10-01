import { getBase58Decoder } from '@solana/kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    MesubProvider,
    MesubSignInCancelledError,
    useMesub,
    type MesubState,
    type MesubUser,
} from '../src';
import { TIMING } from '../src/timing';
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
const heading = () => within(dialog()).getByRole('heading').textContent;
const slots = () =>
    Array.from(dialog().querySelectorAll('[data-mesub-slot]')).map((slot) =>
        slot.getAttribute('data-mesub-slot'),
    );

function type(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string | RegExp) {
    fireEvent.click(within(dialog()).getByRole('button', { name }));
}

async function toCode(email = 'ada@example.com') {
    type('Email', email);
    click('Send me a code');
    await waitFor(() => expect(step()).toBe('code'));
}

async function toWallet() {
    await toCode();
    type('6-digit code', '123456');
    await waitFor(() => expect(step()).toBe('wallet'));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

afterEach(() => {
    unregisterWallets();
    TIMING.resendS = 0;
});

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

    // The CSS draws the icons with :empty: a space would hide them.
    it('starts with an empty close button and the brand, in that order', () => {
        setup();

        const [close, brand] = Array.from(dialog().children);
        expect(close!.hasAttribute('data-mesub-close')).toBe(true);
        expect(close!.getAttribute('aria-label')).toBe('Close');
        expect(close!.childNodes).toHaveLength(0);
        expect(brand!.hasAttribute('data-mesub-brand')).toBe(true);
        expect(brand!.textContent).toBe('mesub.io');
        expect(brand!.querySelector('svg')).not.toBeNull();
    });

    it('leaves the theme to an ancestor unless it is given one', () => {
        setup();

        expect(dialog().hasAttribute('data-mesub-theme')).toBe(false);
    });

    it('sets the theme it is given', () => {
        let state!: MesubState;
        function Probe() {
            state = useMesub();
            return null;
        }
        render(
            <MesubProvider publishableKey="PUB_1" theme="dark" fetch={api(newcomerRoutes)}>
                <Probe />
            </MesubProvider>,
        );
        act(() => {
            void state.login().catch(() => undefined);
        });

        expect(dialog().getAttribute('data-mesub-theme')).toBe('dark');
    });
});

describe('the email step', () => {
    it('sends the trimmed email and moves to the code step', async () => {
        const { fetch } = setup();

        await toCode('  ada@example.com ');

        expect(calls(fetch, '/code')).toEqual([
            { body: { email: 'ada@example.com' }, headers: expect.any(Object) },
        ]);
        expect(heading()).toBe('Enter the code');
        expect(within(dialog()).getByText('ada@example.com').tagName).toBe('STRONG');
        expect(document.activeElement).toBe(screen.getByLabelText('6-digit code'));
    });

    it('shows Sending, busy, while the code is sent', async () => {
        const answer = deferred<Response>();
        setup({ '/code': () => answer.promise });

        type('Email', 'ada@example.com');
        click('Send me a code');

        const button = await within(dialog()).findByRole('button', { name: 'Sending' });
        expect(button.getAttribute('aria-busy')).toBe('true');
        await act(async () => answer.resolve(json(204)));
        await waitFor(() => expect(step()).toBe('code'));
    });

    it.each([
        [400, 'email must be an email address'],
        [403, 'Origin not allowed'],
        [429, 'ThrottlerException: Too Many Requests'],
    ])('shows the API message on %i, marks the field and stays', async (status, message) => {
        setup({ '/code': () => json(status, { message, statusCode: status }) });

        type('Email', 'ada@example');
        click('Send me a code');

        await waitFor(() => expect(error()).toBe(message));
        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
        expect(within(dialog()).getByRole('alert').tagName).toBe('SPAN');
    });

    it('says so when the network fails', async () => {
        setup({ '/code': () => Promise.reject(new TypeError('Failed to fetch')) });

        type('Email', 'ada@example.com');
        click('Send me a code');

        await waitFor(() => expect(error()).toBe('Could not reach the Mesub API'));
        expect(step()).toBe('email');
    });

    it('says so when Mesub does not answer within 15 seconds, and a retry goes through', async () => {
        let hang = true;
        setup({ '/code': () => (hang ? new Promise<never>(() => undefined) : json(204)) });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            type('Email', 'ada@example.com');
            click('Send me a code');
            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(error()).toBe('Mesub did not answer within 15 seconds');
            expect(step()).toBe('email');
        } finally {
            vi.useRealTimers();
        }

        hang = false;
        click('Send me a code');
        await waitFor(() => expect(step()).toBe('code'));
        expect(error()).toBeNull();
    });
});

describe('the code step', () => {
    it('shows six slots that fill as the code is typed', async () => {
        setup();
        await toCode();

        // 'active' follows the focus, which moves in an effect.
        await waitFor(() =>
            expect(slots()).toEqual(['active', 'empty', 'empty', 'empty', 'empty', 'empty']),
        );
        type('6-digit code', '48');

        expect(slots()).toEqual(['filled', 'filled', 'active', 'empty', 'empty', 'empty']);
        const filled = dialog().querySelectorAll('[data-mesub-slot="filled"]');
        expect(Array.from(filled).map((slot) => slot.textContent)).toEqual(['4', '8']);
        expect(dialog().querySelector('[data-mesub-slots]')!.getAttribute('aria-hidden')).toBe(
            'true',
        );
    });

    it('keeps digits only, six at most', async () => {
        setup({ '/code': routes.code, '/session': () => new Promise<never>(() => undefined) });
        await toCode();

        type('6-digit code', '4a8 1-02799');

        expect(screen.getByLabelText('6-digit code')).toHaveProperty('value', '481027');
    });

    it('sends itself at the sixth digit, with no Continue button', async () => {
        const { fetch } = setup();
        await toCode();

        expect(within(dialog()).queryByRole('button', { name: 'Continue' })).toBeNull();
        type('6-digit code', '123456');

        await waitFor(() => expect(step()).toBe('wallet'));
        expect(calls(fetch, '/session')[0]?.body).toEqual({
            email: 'ada@example.com',
            code: '123456',
        });
    });

    it('says it is checking, busy, while the code is checked', async () => {
        const answer = deferred<Response>();
        setup({ '/code': routes.code, '/session': () => answer.promise });
        await toCode();

        type('6-digit code', '123456');

        await waitFor(() =>
            expect(within(dialog()).getByRole('status').textContent).toBe('Checking'),
        );
        expect(dialog().querySelector('[data-mesub-otp]')!.getAttribute('aria-busy')).toBe('true');
        await act(async () => answer.resolve(routes.newSession()));
        await waitFor(() => expect(step()).toBe('wallet'));
    });

    it('shows Signed in for a returning subscriber, with no wallet step, then closes', async () => {
        const { fetch, login, state } = setup({
            '/code': routes.code,
            '/session': routes.returningSession,
        });
        await toCode();

        type('6-digit code', '123456');

        await expect(login).resolves.toEqual(user);
        await waitFor(() => expect(queryDialog()).toBeNull());
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(0);
        expect(state().user).toEqual(user);
        await expect(state().getAccessToken()).resolves.toBe('at_1');
    });

    it('lingers on Signed in for the design pause', async () => {
        TIMING.doneMs = 60_000;
        try {
            setup({ '/code': routes.code, '/session': routes.returningSession });
            await toCode();
            type('6-digit code', '123456');

            await waitFor(() => expect(step()).toBe('done'));
            expect(heading()).toBe('Signed in');
            expect(dialog().querySelector('[data-mesub-hero="check"]')).not.toBeNull();
        } finally {
            TIMING.doneMs = 0;
        }
    });

    it('keeps the session when closed on Signed in', async () => {
        TIMING.doneMs = 60_000;
        try {
            const { login } = setup({ '/code': routes.code, '/session': routes.returningSession });
            await toCode();
            type('6-digit code', '123456');
            await waitFor(() => expect(step()).toBe('done'));

            click('Close');

            await expect(login).resolves.toEqual(user);
        } finally {
            TIMING.doneMs = 0;
        }
    });

    it('marks a wrong code and offers to resend', async () => {
        const { login } = setup({
            '/code': routes.code,
            '/session': () => json(401, { message: 'Wrong code. Enter the one we emailed you.' }),
        });
        await toCode();

        type('6-digit code', '000000');

        await waitFor(() => expect(error()).toBe('Wrong code. Enter the one we emailed you.'));
        expect(step()).toBe('code');
        expect(screen.getByLabelText('6-digit code').getAttribute('aria-invalid')).toBe('true');
        expect(within(dialog()).getByRole('button', { name: 'Resend code' })).toBeTruthy();
        const settled = vi.fn();
        void login.then(settled, settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
    });

    it('offers a new code as the primary action once the code expired', async () => {
        const { fetch } = setup({
            '/code': routes.code,
            '/session': () => json(401, { message: 'That code expired. Ask for a new one.' }),
        });
        await toCode();
        type('6-digit code', '000000');
        await waitFor(() => expect(error()).toBe('That code expired. Ask for a new one.'));

        const button = within(dialog()).getByRole('button', { name: 'Send a new code' });
        expect(button.hasAttribute('data-mesub-submit')).toBe(true);
        fireEvent.click(button);

        await waitFor(() =>
            expect(within(dialog()).getByRole('status').textContent).toBe('We sent a new code.'),
        );
        expect(calls(fetch, '/code')).toHaveLength(2);
        expect(slots()).toEqual(['active', 'empty', 'empty', 'empty', 'empty', 'empty']);
    });

    it('holds the resend back with a countdown', async () => {
        TIMING.resendS = 30;
        setup();
        await toCode();

        const resend = within(dialog()).getByRole('button', { name: 'Resend in 30s' });
        expect(resend).toHaveProperty('disabled', true);
        expect(resend.hasAttribute('data-mesub-resend')).toBe(true);
    });

    it('sends the code again and says so', async () => {
        const { fetch } = setup();
        await toCode();

        click('Resend code');

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

        click('Resend code');

        await waitFor(() => expect(error()).toBe('Too many codes asked for'));
        expect(within(dialog()).queryByRole('status')).toBeNull();
    });

    it('goes back to the email step through the icon, keeping the email', async () => {
        setup();
        await toCode();

        const back = within(dialog()).getByRole('button', { name: 'Back' });
        expect(back.childNodes).toHaveLength(0);
        expect(dialog().firstElementChild).toBe(back);
        fireEvent.click(back);

        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email')).toHaveProperty('value', 'ada@example.com');
        expect(document.activeElement).toBe(screen.getByLabelText('Email'));
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

        expect(heading()).toBe('Connect a wallet');
        const list = within(dialog()).getByRole('list', { name: 'Wallets in this browser' });
        expect(list.hasAttribute('data-mesub-wallets')).toBe(true);
        expect(
            within(list)
                .getAllByRole('button')
                .map((button) => button.textContent),
        ).toEqual(['Phantom']);
        expect(within(list).getByRole('button').getAttribute('data-mesub-wallet')).toBe('Phantom');
        expect(document.activeElement).toBe(within(list).getByRole('button'));
    });

    // The code is spent: back means the email again, and a new code.
    it('goes back from the list to the email, the code spent', async () => {
        registerWallet({ name: 'Phantom' });
        const { fetch } = setup();
        await toWallet();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));

        expect(step()).toBe('email');
        expect(screen.getByLabelText('Email')).toHaveProperty('value', 'ada@example.com');
        click('Send me a code');
        await waitFor(() => expect(step()).toBe('code'));
        expect(calls(fetch, '/code')).toHaveLength(2);
        expect(screen.getByLabelText('6-digit code')).toHaveProperty('value', '');
    });

    it('offers to install a wallet when none is there', async () => {
        setup();

        await toWallet();

        expect(heading()).toBe('No Solana wallet found');
        const links = dialog().querySelectorAll('a[data-mesub-install]');
        expect(Array.from(links).map((link) => link.getAttribute('href'))).toEqual([
            'https://phantom.com',
            'https://solflare.com',
        ]);
        expect(within(dialog()).getByRole('button', { name: 'Reload' })).toBeTruthy();
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

    it('marks the wallet used last on this device', async () => {
        registerWallet({ name: 'Phantom' });
        registerWallet({
            name: 'Solflare',
            address: 'So1f1are111111111111111111111111111111111111',
        });
        localStorage.setItem('mesub:last-wallet', 'Solflare');
        setup();
        await toWallet();

        const badges = dialog().querySelectorAll('[data-mesub-badge]');
        expect(badges).toHaveLength(1);
        expect(badges[0]!.closest('[data-mesub-wallet]')!.getAttribute('data-mesub-wallet')).toBe(
            'Solflare',
        );
    });

    it('remembers the wallet that signed in', async () => {
        registerWallet({ name: 'Phantom' });
        const { login } = setup();
        await toWallet();

        click('Phantom');
        await login;

        expect(localStorage.getItem('mesub:last-wallet')).toBe('Phantom');
    });

    it('waits on the wallet, with a way to pick another', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        const signed = deferred<{ signedMessage: Uint8Array; signature: Uint8Array }[]>();
        fake.signMessage.mockImplementationOnce(() => signed.promise);
        const { login } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(heading()).toBe('Approve in Phantom'));
        expect(dialog().querySelector('[data-mesub-hero="wait"] img')).not.toBeNull();
        expect(within(dialog()).getByText('Check the Phantom window.')).toBeTruthy();
        expect(within(dialog()).getByRole('button', { name: 'Use another wallet' })).toBeTruthy();
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

    it('shows a refused signature, and signs on Try again', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { fetch, login } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe('Phantom said: User rejected the request.'));
        expect(heading()).toBe('Request rejected');
        expect(dialog().querySelector('[data-mesub-hero="error"]')).not.toBeNull();
        expect(step()).toBe('wallet');
        expect(calls(fetch, '/wallet')).toHaveLength(0);

        click('Try again');

        await expect(login).resolves.toEqual(user);
        expect(fake.signMessage).toHaveBeenCalledTimes(2);
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(2);
    });

    it('goes back to the list from a refusal', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));
        setup();
        await toWallet();
        click('Phantom');
        await waitFor(() => expect(heading()).toBe('Request rejected'));

        click('Use another wallet');

        expect(heading()).toBe('Connect a wallet');
    });

    it('shows a wallet that did not connect', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        fake.connect.mockRejectedValueOnce(new Error('closed'));
        const { fetch } = setup();
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(error()).toBe('Phantom said: closed'));
        expect(calls(fetch, '/wallet/challenge')).toHaveLength(0);
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

    it('says a wallet held by another account is already in use', async () => {
        registerWallet({ name: 'Phantom' });
        setup({
            ...newcomerRoutes,
            '/wallet': () =>
                json(409, { message: 'That wallet is already attached to another account.' }),
        });
        await toWallet();

        click('Phantom');

        await waitFor(() => expect(heading()).toBe('Wallet already in use'));
        expect(error()).toBe('That wallet is already attached to another account.');
        click('Use another wallet');
        expect(heading()).toBe('Connect a wallet');
    });

    it.each([
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
        expect(heading()).toBe('Could not connect');
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

    it('rejects login() on a click on the backdrop', async () => {
        const { login } = setup();
        dialog().getBoundingClientRect = () => new DOMRect(100, 100, 300, 300);

        fireEvent.click(dialog(), { clientX: 20, clientY: 20 });

        await expect(login).rejects.toBeInstanceOf(MesubSignInCancelledError);
        expect(queryDialog()).toBeNull();
    });

    it('stays open on a click inside it, its padding included', () => {
        setup();
        dialog().getBoundingClientRect = () => new DOMRect(100, 100, 300, 300);

        fireEvent.click(dialog(), { clientX: 105, clientY: 105 });
        fireEvent.click(screen.getByLabelText('Email'), { clientX: 20, clientY: 20 });

        expect(queryDialog()).not.toBeNull();
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
        type('6-digit code', '123456');

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
