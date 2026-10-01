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
const NOW = new Date('2026-10-01T12:00:00.000Z');

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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the code' }));
    fireEvent.change(await within(dialog).findByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
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

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    unregisterWallets();
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

    it('shows the merchant, the price, the cadence and what happens next', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();

        await openReview();

        const view = within(dialog());
        expect(view.getByRole('heading').textContent).toBe('Pro');
        expect(dialog().querySelector('[data-mesub-merchant]')!.textContent).toBe('Fraise');
        expect(dialog().querySelector('[data-mesub-merchant] img')!.getAttribute('src')).toBe(
            'https://cdn.test/fraise.png',
        );
        expect(dialog().querySelector('[data-mesub-price]')!.textContent).toBe(
            '2 USDC every 3 days',
        );
        const row = (name: string) =>
            dialog().querySelector(`[data-mesub-row="${name}"] dd`)!.textContent;
        expect(row('due')).toBe('2 USDC');
        expect(row('next')).toBe(
            new Date('2026-10-04T12:00:00.000Z').toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            }),
        );
        expect(row('wallet')).toBe('Wa11…1111');
        expect(view.getByText(/Cancel anytime/)).toBeTruthy();
        expect(view.getByRole('button', { name: 'Subscribe and pay 2 USDC' })).toBeTruthy();
    });

    it('marks the test network on devnet, and not on mainnet', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup();
        await openReview();

        expect(dialog().querySelector('[data-mesub-network="devnet"]')).not.toBeNull();
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

    it('refuses to start a plan that takes no new subscribers', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: { 'GET /plans/pro': () => json(200, { ...plan, available: false }) },
        });
        await openReview();

        expect(within(dialog()).getByRole('alert').textContent).toBe(
            'This plan is not taking new subscribers right now.',
        );
        expect(within(dialog()).getByRole('button', { name: /Subscribe and pay/ })).toHaveProperty(
            'disabled',
            true,
        );
    });

    it('says so when the plan cannot be read', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: { 'GET /plans/pro': () => json(404, { message: 'No plan under slug pro' }) },
        });

        fireEvent.click(subscribeButton());

        expect(
            (await within(await screen.findByRole('dialog')).findByRole('alert')).textContent,
        ).toBe('No plan under slug pro');
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
    it('signs in inside the same window, then shows the review', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await setup({ signedIn: false });

        fireEvent.click(subscribeButton());
        const window = await screen.findByRole('dialog');
        expect(window.getAttribute('data-mesub-step')).toBe('email');

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
        expect(within(dialog()).getByRole('heading').textContent).toBe('Approve in Phantom');
        expect(subscribeButton().getAttribute('data-mesub-state')).toBe('signing');

        await act(async () => sent.resolve([{ signature: fake.signature }]));
        await waitFor(() => expect(step()).toBe('confirming'));
        const signature = getBase58Decoder().decode(fake.signature);
        expect(dialog().querySelector('[data-mesub-explorer]')!.getAttribute('href')).toBe(
            `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        );

        await act(async () => answer.resolve(json(201, { subscription: active })));
        await waitFor(() => expect(step()).toBe('subscribed'));
        expect(within(dialog()).getByRole('heading').textContent).toBe('You are subscribed');
        expect(dialog().querySelector('[data-mesub-row="paid"] dd')!.textContent).toBe('2 USDC');
        expect(dialog().querySelector('[data-mesub-row="receipt"] a')).not.toBeNull();
        expect(onSubscribed).toHaveBeenCalledWith(active);
        expect(calls(fetch, 'POST /subscriptions')).toHaveLength(1);

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(subscribeButton().textContent).toBe('Subscribed');
        expect(subscribeButton()).toHaveProperty('disabled', true);
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

describe('errors', () => {
    it('keeps a wallet refusal on the approve step, says nothing was charged, and retries', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { onSubscribed } = await setup();
        await openReview();

        pay();
        const alert = await within(dialog()).findByRole('alert');
        expect(step()).toBe('approve');
        expect(alert.textContent).toBe(
            'Phantom did not send the transaction. It said: User rejected the request. Nothing was charged.',
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
        await within(dialog()).findByRole('alert');
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));

        expect(step()).toBe('review');
        expect(within(dialog()).queryByRole('alert')).toBeNull();
    });

    it('shows a refusal before any prompt on the review', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                'POST /subscriptions': () =>
                    json(409, { message: 'You are already subscribed to this plan.' }),
            },
        });
        await openReview();

        pay();

        await waitFor(() =>
            expect(within(dialog()).getByRole('alert').textContent).toBe(
                'You are already subscribed to this plan. Nothing was charged.',
            ),
        );
        expect(step()).toBe('review');
        expect(fake.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a wallet on another account, on the review', async () => {
        registerWallet({
            name: 'Phantom',
            address: 'Other11111111111111111111111111111111111111',
            connected: true,
        });
        await setup();
        await openReview();

        pay();

        await waitFor(() =>
            expect(within(dialog()).getByRole('alert').textContent).toMatch(
                /^Phantom is on Othe…1111, but you signed in with Wa11…1111\..* Nothing was charged\.$/,
            ),
        );
        expect(step()).toBe('review');
    });

    it('shows the reason when the transaction did not settle, without claiming nothing moved', async () => {
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

        await waitFor(() => expect(within(dialog()).queryByRole('alert')).not.toBeNull());
        expect(step()).toBe('confirming');
        expect(within(dialog()).getByRole('alert').textContent).toBe(
            'The transaction expired before it landed.',
        );
    });

    it('tells the subscriber to wait when Mesub cannot be reached after sending', async () => {
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

        await waitFor(() =>
            expect(within(dialog()).getByRole('alert').textContent).toMatch(
                /^Solana did not confirm in time\./,
            ),
        );
        expect(step()).toBe('confirming');
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
