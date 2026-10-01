import { getBase58Decoder } from '@solana/kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    MesubProvider,
    SubscribeButton,
    useMesub,
    type MesubPlan,
    type MesubState,
    type MesubSubscription,
} from '../src';
import { json, user } from './helpers';
import { registerWallet, unregisterWallets } from './wallets';

const API = 'http://api.test/v1/client';
const TX_BASE64 = btoa(String.fromCharCode(1, 2, 3));

const plan: MesubPlan = {
    slug: 'pro',
    name: 'Pro',
    description: 'Every report, every week.',
    amount: '2000000',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    periodHours: 72,
    network: 'devnet',
    merchant: { name: 'Fraise', logoUrl: 'https://cdn.test/fraise.png', websiteUrl: null },
    available: true,
};
const pending: MesubSubscription = {
    id: 'sub_1',
    planId: 'pln_1',
    subscriber: user.walletAddress!,
    status: 'PENDING',
    currentPeriodStartTs: null,
    dueAt: null,
    expiresAtTs: '0',
    createTxSignature: null,
    confirmedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
};
const active: MesubSubscription = {
    ...pending,
    status: 'ACTIVE',
    currentPeriodStartTs: '1',
    dueAt: '2026-10-04T12:00:00.000Z',
};

type Handler = (body: Record<string, unknown> | null) => Response | Promise<Response>;

const routes: Record<string, Handler> = {
    'GET /plans/pro': () => json(200, plan),
    'POST /auth/code': () => json(204),
    'POST /auth/session': () =>
        json(201, { user, sessionToken: 'st_1', refreshToken: 'rt_1', accessToken: 'at_1' }),
    'POST /subscriptions': () => json(201, pending),
    'POST /subscriptions/sub_1/transaction': () =>
        json(201, { transaction: TX_BASE64, lastValidBlockHeight: '100' }),
    'POST /subscriptions/sub_1/confirm': () => json(201, { subscription: active }),
};

function api(overrides: Record<string, Handler> = {}) {
    const handlers = { ...routes, ...overrides };
    return vi.fn(async (url: string, init: RequestInit) => {
        const key = `${init.method} ${url.slice(API.length)}`;
        const handler = handlers[key];
        if (!handler) throw new Error(`unexpected call to ${key}`);
        return handler(
            init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
        );
    });
}

function calls(fetch: ReturnType<typeof api>, key: string) {
    return fetch.mock.calls.filter(
        ([url, init]) => `${init.method} ${url.slice(API.length)}` === key,
    );
}

async function setup({
    overrides,
    signedIn = true,
    chain,
}: { overrides?: Record<string, Handler>; signedIn?: boolean; chain?: `solana:${string}` } = {}) {
    const fetch = api(overrides);
    const onSubscribed = vi.fn();
    let state!: MesubState;
    function Probe() {
        state = useMesub();
        return null;
    }
    render(
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
            <Probe />
            <SubscribeButton plan="pro" chain={chain} onSubscribed={onSubscribed} />
        </MesubProvider>,
    );
    if (signedIn) {
        let login!: Promise<unknown>;
        act(() => {
            login = state.login();
        });
        await signInSteps(await screen.findByRole('dialog'));
        await act(async () => {
            await login;
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    return { fetch, onSubscribed };
}

async function signInSteps(dialog: HTMLElement) {
    fireEvent.change(within(dialog).getByLabelText('Email'), {
        target: { value: 'ada@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send me a code' }));
    fireEvent.change(await within(dialog).findByLabelText('6-digit code'), {
        target: { value: '123456' },
    });
}

const subscribeButton = () =>
    screen.getByRole('button', { name: /Subscribe$|Subscribed|Approve|Confirming/ });
const dialog = () => screen.getByRole('dialog');
const step = () => dialog().getAttribute('data-mesub-step');
const pay = () =>
    fireEvent.click(within(dialog()).getByRole('button', { name: /Subscribe and pay/ }));

async function openReview() {
    fireEvent.click(subscribeButton());
    await within(await screen.findByRole('dialog')).findByRole('button', {
        name: /Subscribe and pay/,
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

afterEach(() => unregisterWallets());

const heading = () => within(dialog()).getByRole('heading').textContent;
const alertText = () => within(dialog()).queryByRole('alert')?.textContent ?? null;
const funds = () =>
    dialog().querySelector('[data-mesub-funds]')?.getAttribute('data-mesub-funds') ?? null;
const hero = () =>
    dialog().querySelector('[data-mesub-hero]')?.getAttribute('data-mesub-hero') ?? null;
const rows = () =>
    Array.from(dialog().querySelectorAll('[data-mesub-row]')).map((row) => [
        row.querySelector('dt')!.textContent,
        row.querySelector('dd')!.textContent,
    ]);
const date = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

describe('the review', () => {
    it('opens on click and signs nothing yet', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await setup();

        await openReview();

        expect(step()).toBe('review');
        expect(calls(fetch, 'POST /subscriptions')).toHaveLength(0);
        expect(fake.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('reads the plan with the publishable key, as a GET without a body', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await setup();

        await openReview();

        const [url, init] = calls(fetch, 'GET /plans/pro')[0]!;
        expect(url).toBe(`${API}/plans/pro`);
        expect(init.body).toBeUndefined();
        expect(init.headers).toEqual({ 'X-Mesub-Key': 'PUB_1' });
    });

    it('shows the merchant, the plan and its price, terms folded away', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();

        await openReview();

        const merchant = dialog().querySelector('[data-mesub-merchant]')!;
        expect(merchant.querySelector('strong')!.textContent).toBe('Fraise');
        expect(merchant.querySelector('img')!.getAttribute('src')).toBe(
            'https://cdn.test/fraise.png',
        );
        expect(heading()).toBe('Pro');
        const price = dialog().querySelector('[data-mesub-price]')!;
        expect(price.querySelector('strong')!.textContent).toBe('2 USDC');
        expect(price.querySelector('span')!.textContent).toBe('every 3 days');
        const terms = dialog().querySelector('details[data-mesub-terms]')!;
        expect(terms.hasAttribute('open')).toBe(false);
        expect(terms.querySelector('summary')!.textContent).toBe('Payment details and terms');
        expect(rows()).toEqual([
            ['Due today', '2 USDC'],
            ['Next charge', date(new Date(Date.now() + 72 * 3_600_000).toISOString())],
            ['Pays from', 'Wa11…1111'],
            ['Network fee', '≈ 0.002 SOL'],
        ]);
        expect(
            within(dialog()).getByRole('button', { name: 'Subscribe and pay 2 USDC' }),
        ).toBeTruthy();
        expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    it('focuses the primary button', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        expect(document.activeElement).toBe(
            within(dialog()).getByRole('button', { name: /Subscribe and pay/ }),
        );
    });

    it('marks the test network on devnet', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        const badge = dialog().querySelector('[data-mesub-merchant] [data-mesub-network="devnet"]');
        expect(badge!.textContent).toBe('Test network');
    });

    it('does not mark mainnet as a test network', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({ chain: 'solana:mainnet' });
        await openReview();

        expect(dialog().querySelector('[data-mesub-network]')).toBeNull();
    });

    it('names the mint when Mesub cannot vouch for its symbol', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: { 'GET /plans/pro': () => json(200, { ...plan, symbol: null }) },
        });
        await openReview();

        expect(
            within(dialog()).getByRole('button', { name: 'Subscribe and pay 2 EPjF…Dt1v' }),
        ).toBeTruthy();
    });

    it('shows a plan that takes no new subscribers as closed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: { 'GET /plans/pro': () => json(200, { ...plan, available: false }) },
        });

        fireEvent.click(subscribeButton());
        await waitFor(() => expect(heading()).toBe('Plan closed'));

        expect(step()).toBe('review');
        expect(hero()).toBe('error');
        expect(alertText()).toBe('This plan is not taking new subscribers right now.');
        expect(funds()).toBe('safe');
        fireEvent.click(dialog().querySelector<HTMLElement>('[data-mesub-done]')!);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('says so when the plan cannot be read', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: { 'GET /plans/pro': () => json(404, { message: 'No plan under slug pro' }) },
        });

        fireEvent.click(subscribeButton());

        await waitFor(() => expect(alertText()).toBe('No plan under slug pro'));
        expect(heading()).toBe('Plan not found');
    });

    it('offers a retry when Mesub did not answer for the plan', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        let first = true;
        await setup({
            overrides: {
                'GET /plans/pro': () => {
                    if (!first) return json(200, plan);
                    first = false;
                    throw new TypeError('Failed to fetch');
                },
            },
        });

        fireEvent.click(subscribeButton());
        await waitFor(() => expect(heading()).toBe('Mesub did not answer'));
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));

        await waitFor(() => expect(heading()).toBe('Pro'));
    });

    it('closes on Cancel, leaving the button idle', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(subscribeButton().getAttribute('data-mesub-state')).toBe('idle');
    });

    it('closes on Escape', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        fireEvent.keyDown(dialog(), { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
});

describe('signed out', () => {
    it('signs in inside the same window, for the merchant, then shows the review', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await setup({ signedIn: false });

        fireEvent.click(subscribeButton());
        const window = await screen.findByRole('dialog');
        expect(window.getAttribute('data-mesub-step')).toBe('email');
        await waitFor(() => expect(heading()).toBe('Sign in to subscribe'));
        expect(window.querySelector('[data-mesub-merchant] strong')!.textContent).toBe('Fraise');

        await signInSteps(window);

        await waitFor(() => expect(step()).toBe('review'));
        // The same dialog all along, never closed in between.
        expect(dialog()).toBe(window);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(calls(fetch, 'POST /auth/session')).toHaveLength(1);
    });
});

describe('paying', () => {
    it('approves, confirms, and ends on the receipt', async () => {
        const sent = deferred<{ signature: Uint8Array }[]>();
        const answer = deferred<Response>();
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockImplementation(() => sent.promise);
        const { fetch, onSubscribed } = await setup({
            overrides: { 'POST /subscriptions/sub_1/confirm': () => answer.promise },
        });
        await openReview();

        pay();
        await waitFor(() => expect(fake.signAndSendTransaction).toHaveBeenCalled());
        expect(step()).toBe('approve');
        expect(heading()).toBe('Approve in Phantom');
        expect(hero()).toBe('wait');
        expect(
            within(dialog()).getByText('One transaction: 2 USDC now, then 2 USDC every 3 days.'),
        ).toBeTruthy();
        expect(subscribeButton().getAttribute('data-mesub-state')).toBe('signing');

        await act(async () => sent.resolve([{ signature: fake.signature }]));
        await waitFor(() => expect(step()).toBe('confirming'));
        expect(heading()).toBe('Confirming on Solana');
        const signature = getBase58Decoder().decode(fake.signature);
        const explorer = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
        expect(dialog().querySelector('[data-mesub-explorer]')!.getAttribute('href')).toBe(
            explorer,
        );

        await act(async () => answer.resolve(json(201, { subscription: active })));
        await waitFor(() => expect(step()).toBe('subscribed'));
        expect(heading()).toBe('You are subscribed');
        expect(hero()).toBe('check');
        expect(within(dialog()).getByText('Pro, 2 USDC every 3 days')).toBeTruthy();
        expect(rows()).toEqual([
            ['Paid today', '2 USDC'],
            ['Next charge', date(active.dueAt!)],
            ['Receipt', 'View'],
        ]);
        expect(
            dialog().querySelector('[data-mesub-row] a[data-mesub-explorer]')!.getAttribute('href'),
        ).toBe(explorer);
        expect(onSubscribed).toHaveBeenCalledWith(active);
        expect(calls(fetch, 'POST /subscriptions')).toHaveLength(1);

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(subscribeButton().textContent).toBe('Subscribed');
        expect(subscribeButton()).toHaveProperty('disabled', true);
        expect(document.querySelector('[data-mesub-receipt] a')!.getAttribute('href')).toBe(
            explorer,
        );
    });

    it('links to the subscriber page on Mesub, in a new tab', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        pay();
        await waitFor(() => expect(step()).toBe('subscribed'));

        const manage = dialog().querySelector('a[data-mesub-manage]')!;
        expect(manage.textContent).toBe('See details on mesub.io');
        expect(manage.getAttribute('href')).toBe('https://mesub.io/subscriptions');
        expect(manage.getAttribute('target')).toBe('_blank');
        expect(manage.querySelector('svg')).not.toBeNull();
    });

    it('never disconnects the wallet', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        pay();
        await waitFor(() => expect(step()).toBe('subscribed'));

        expect(fake.disconnect).not.toHaveBeenCalled();
    });
});

describe('going back', () => {
    it('goes back from approve to the review', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockImplementation(() => new Promise(() => undefined));
        await setup();
        await openReview();
        pay();
        await waitFor(() => expect(step()).toBe('approve'));

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));

        expect(step()).toBe('review');
    });

    it('goes back from an error to the review through the icon', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        await setup();
        await openReview();
        pay();
        await waitFor(() => expect(heading()).toBe('Not approved'));

        const back = dialog().querySelector<HTMLElement>('[data-mesub-back]:empty')!;
        expect(dialog().firstElementChild).toBe(back);
        fireEvent.click(back);

        expect(step()).toBe('review');
    });

    // A payment may still land: going back could pay twice.
    it('offers no way back while a payment may be pending', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions/sub_1/confirm': () => {
                    throw new TypeError('Failed to fetch');
                },
            },
        });
        await openReview();
        pay();
        await waitFor(() => expect(heading()).toBe('Still confirming'));

        expect(dialog().querySelector('[data-mesub-back]')).toBeNull();
    });

    it('offers no way back once subscribed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();
        pay();
        await waitFor(() => expect(step()).toBe('subscribed'));

        expect(dialog().querySelector('[data-mesub-back]')).toBeNull();
    });
});

describe('errors', () => {
    it('says a closed wallet charged nothing, and retries', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { onSubscribed } = await setup();
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Not approved'));
        expect(step()).toBe('approve');
        expect(hero()).toBe('error');
        expect(alertText()).toBe('You closed Phantom before approving.');
        expect(funds()).toBe('safe');
        expect(dialog().querySelector('[data-mesub-funds]')!.textContent).toBe(
            'Nothing was charged.',
        );

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(step()).toBe('subscribed'));
        expect(onSubscribed).toHaveBeenCalledOnce();
    });

    it('goes back to the review from a refusal', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        await setup();
        await openReview();

        pay();
        await waitFor(() => expect(heading()).toBe('Not approved'));
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back to review' }));

        expect(step()).toBe('review');
        expect(heading()).toBe('Pro');
    });

    it('names the account to switch to', async () => {
        registerWallet({
            name: 'Phantom',
            address: 'Other11111111111111111111111111111111111111',
            connected: true,
        });
        await setup();
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Wrong account in Phantom'));
        expect(step()).toBe('approve');
        expect(alertText()).toBe(
            'Phantom is on Othe…1111, you signed in with Wa11…1111. Switch account, then try again.',
        );
        expect(
            Array.from(dialog().querySelectorAll('[data-mesub-error] code')).map(
                (c) => c.textContent,
            ),
        ).toEqual(['Othe…1111', 'Wa11…1111']);
        expect(funds()).toBe('safe');
    });

    it('says the payment did not go through when the wallet holds too little', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions/sub_1/transaction': () =>
                    json(409, {
                        message:
                            'You need 2 USDC to pay the first period, and this wallet holds 0 USDC.',
                    }),
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Payment did not go through'));
        expect(step()).toBe('approve');
        expect(alertText()).toBe(
            'You need 2 USDC to pay the first period, and this wallet holds 0 USDC.',
        );
        expect(funds()).toBe('safe');
        expect(fake.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('shows Already subscribed with nothing but a Close', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions': () =>
                    json(409, { message: 'You are already subscribed to this plan.' }),
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Already subscribed'));
        expect(step()).toBe('review');
        expect(alertText()).toBe('You are already subscribed to this plan.');
        expect(funds()).toBeNull();
        expect(dialog().querySelector('[data-mesub-done]')!.textContent).toBe('Close');
        expect(dialog().querySelector('[data-mesub-submit]')).toBeNull();
    });

    it('shows a plan closed since the review', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions': () =>
                    json(409, {
                        message:
                            'This plan is not taking new subscribers right now. Its merchant has been told.',
                    }),
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Plan closed'));
        expect(funds()).toBe('safe');
    });

    it('says Mesub did not answer when it could not be reached before sending', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions': () => {
                    throw new TypeError('Failed to fetch');
                },
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Mesub did not answer'));
        expect(step()).toBe('review');
        expect(alertText()).toBe('No reply within 15 seconds.');
        expect(funds()).toBe('safe');
    });

    it('says nothing went through when the transaction did not settle', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions/sub_1/confirm': () =>
                    json(201, {
                        subscription: pending,
                        reason: 'The transaction expired before it landed.',
                    }),
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Payment did not go through'));
        expect(step()).toBe('confirming');
        expect(alertText()).toBe('The transaction expired before it landed.');
        expect(funds()).toBe('safe');
    });

    it('says the payment may be pending when Mesub cannot be reached after sending, and checks again', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        let reachable = false;
        const { fetch, onSubscribed } = await setup({
            overrides: {
                'POST /subscriptions/sub_1/confirm': () => {
                    if (!reachable) throw new TypeError('Failed to fetch');
                    return json(201, { subscription: active });
                },
            },
        });
        await openReview();

        pay();

        await waitFor(() => expect(heading()).toBe('Still confirming'));
        expect(step()).toBe('confirming');
        expect(hero()).toBe('pending');
        expect(alertText()).toMatch(/^If Phantom shows the transaction as sent, wait a minute/);
        expect(funds()).toBe('pending');
        expect(dialog().querySelector('[data-mesub-funds]')!.textContent).toBe(
            'Payment may be pending.',
        );
        expect(dialog().querySelector('[data-mesub-explorer]')).not.toBeNull();

        reachable = true;
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Check again' }));

        await waitFor(() => expect(step()).toBe('subscribed'));
        // Re-polled, never paid twice.
        expect(fake.signAndSendTransaction).toHaveBeenCalledOnce();
        expect(calls(fetch, 'POST /subscriptions')).toHaveLength(1);
        const signature = getBase58Decoder().decode(fake.signature);
        expect(
            calls(fetch, 'POST /subscriptions/sub_1/confirm').map(([, init]) =>
                JSON.parse(init.body as string),
            ),
        ).toEqual([{ signature }, { signature }]);
        expect(onSubscribed).toHaveBeenCalledOnce();
    });
});

describe('without the checkout', () => {
    it('signs at once with checkout={false}', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        const fetch = api();
        let state!: MesubState;
        function Probe() {
            state = useMesub();
            return null;
        }
        render(
            <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
                <Probe />
                <SubscribeButton plan="pro" checkout={false} />
            </MesubProvider>,
        );
        let login!: Promise<unknown>;
        act(() => {
            login = state.login();
        });
        await signInSteps(await screen.findByRole('dialog'));
        await act(async () => {
            await login;
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));

        await waitFor(() => expect(fake.signAndSendTransaction).toHaveBeenCalled());
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(calls(fetch, 'GET /plans/pro')).toHaveLength(0);
    });
});
