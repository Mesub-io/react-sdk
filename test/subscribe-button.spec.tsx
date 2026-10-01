import { getBase58Decoder } from '@solana/kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import {
    MesubProvider,
    SubscribeButton,
    useMesub,
    useSubscribe,
    type MesubState,
    type MesubSubscription,
} from '../src';
import { json, user } from './helpers';
import { registerWallet, unregisterWallets } from './wallets';

const API = 'http://api.test/v1/client';
const TX_BYTES = new Uint8Array([1, 2, 3, 250, 0, 128]);
const TX_BASE64 = btoa(String.fromCharCode(...TX_BYTES));

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
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
};
const active: MesubSubscription = { ...pending, status: 'ACTIVE', currentPeriodStartTs: '1' };

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

const routes: Record<string, Handler> = {
    '/auth/code': () => json(204),
    '/auth/session': () =>
        json(201, { user, sessionToken: 'st_1', refreshToken: 'rt_1', accessToken: 'at_1' }),
    '/subscriptions': () => json(201, pending),
    '/subscriptions/sub_1/transaction': () =>
        json(201, { transaction: TX_BASE64, lastValidBlockHeight: '100' }),
    '/subscriptions/sub_1/confirm': () => json(201, { subscription: active }),
};

/** The API, one handler per route. A route with no handler fails the test. */
function api(overrides: Record<string, Handler> = {}) {
    const handlers = { ...routes, ...overrides };
    return vi.fn(async (url: string, init: RequestInit) => {
        const path = url.slice(API.length);
        const handler = handlers[path];
        if (!handler) throw new Error(`unexpected call to ${path}`);
        return handler(JSON.parse(init.body as string) as Record<string, unknown>);
    });
}

function calls(fetch: ReturnType<typeof api>, path: string) {
    return fetch.mock.calls
        .filter(([url]) => url === `${API}${path}`)
        .map(([, init]) => ({
            body: JSON.parse(init.body as string) as unknown,
            headers: init.headers as Record<string, string>,
        }));
}

interface Setup {
    overrides?: Record<string, Handler>;
    signedIn?: boolean;
    props?: Partial<Parameters<typeof SubscribeButton>[0]>;
}

async function setup({ overrides, signedIn = true, props }: Setup = {}) {
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
            <SubscribeButton plan="pro" checkout={false} onSubscribed={onSubscribed} {...props} />
        </MesubProvider>,
    );
    if (signedIn) await signIn(() => state);
    return { fetch, onSubscribed, state: () => state };
}

/** A returning subscriber: email, code, done. */
async function signIn(state: () => MesubState) {
    let login!: Promise<unknown>;
    act(() => {
        login = state().login();
    });
    await completeModal();
    await act(async () => {
        await login;
    });
}

async function completeModal() {
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email'), {
        target: { value: 'ada@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the code' }));
    const code = await within(dialog).findByLabelText('Code');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

const button = () => screen.getByRole('button', { name: /./ });
const stateOf = () => button().getAttribute('data-mesub-state');
const alert = () => screen.queryByRole('alert')?.textContent ?? null;
const click = () => fireEvent.click(button());

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

afterEach(() => unregisterWallets());

describe('rendering', () => {
    it('is a plain button, idle, labelled Subscribe', async () => {
        await setup({ signedIn: false });

        expect(button().tagName).toBe('BUTTON');
        expect(button().getAttribute('type')).toBe('button');
        expect(button().textContent).toBe('Subscribe');
        expect(button().hasAttribute('data-mesub-subscribe')).toBe(true);
        expect(stateOf()).toBe('idle');
    });

    it('takes its label from children and passes other props through', async () => {
        await setup({
            signedIn: false,
            props: { children: 'Go pro', id: 'buy', 'aria-describedby': 'price', title: 'Pro' },
        });

        expect(button().textContent).toBe('Go pro');
        expect(button().id).toBe('buy');
        expect(button().getAttribute('aria-describedby')).toBe('price');
        expect(button().title).toBe('Pro');
    });

    it('carries no class names or styles of its own', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({ overrides: { '/subscriptions': () => json(404, { message: 'Nope' }) } });
        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(document.body.querySelectorAll('[class]')).toHaveLength(0);
        expect(document.body.querySelectorAll('[style]')).toHaveLength(0);
    });

    it('lets a merchant onClick prevent the flow', async () => {
        const { fetch } = await setup({
            props: { onClick: (event) => event.preventDefault() },
        });

        click();

        expect(stateOf()).toBe('idle');
        expect(calls(fetch, '/subscriptions')).toHaveLength(0);
    });
});

describe('subscribing', () => {
    it('reserves, fetches the transaction, has the wallet send it, confirms', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        const { fetch, onSubscribed } = await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        const [reserve] = calls(fetch, '/subscriptions');
        expect(reserve!.body).toEqual({ plan: 'pro' });
        expect(reserve!.headers).toEqual({
            'X-Mesub-Key': 'PUB_1',
            'Content-Type': 'application/json',
            Authorization: 'Bearer at_1',
        });
        const [transaction] = calls(fetch, '/subscriptions/sub_1/transaction');
        expect(transaction!.headers.Authorization).toBe('Bearer at_1');

        expect(fake.signAndSendTransaction).toHaveBeenCalledOnce();
        const input = fake.signAndSendTransaction.mock.calls[0]![0]!;
        expect(input.account.address).toBe(user.walletAddress);
        expect(input.chain).toBe('solana:devnet');
        expect(Array.from(input.transaction)).toEqual(Array.from(TX_BYTES));

        const [confirm] = calls(fetch, '/subscriptions/sub_1/confirm');
        expect(confirm!.body).toEqual({ signature: getBase58Decoder().decode(fake.signature) });
        expect(confirm!.headers.Authorization).toBe('Bearer at_1');

        expect(onSubscribed).toHaveBeenCalledOnce();
        expect(onSubscribed).toHaveBeenCalledWith(active);
        expect(button().textContent).toBe('Subscribed');
        expect(button()).toHaveProperty('disabled', true);
        expect(alert()).toBeNull();
    });

    it('never disconnects the wallet', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        expect(fake.disconnect).not.toHaveBeenCalled();
    });

    it('sends on the chain it is given', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        await setup({ props: { chain: 'solana:mainnet' } });

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        expect(fake.signAndSendTransaction.mock.calls[0]![0]!.chain).toBe('solana:mainnet');
    });

    it('signs in first when signed out, then carries on', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, onSubscribed } = await setup({ signedIn: false });

        click();
        await completeModal();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        expect(calls(fetch, '/auth/session')).toHaveLength(1);
        expect(calls(fetch, '/subscriptions')).toHaveLength(1);
        expect(onSubscribed).toHaveBeenCalledWith(active);
    });

    it('goes back to idle when the sign-in is closed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await setup({ signedIn: false });

        click();
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        expect(stateOf()).toBe('idle');
        expect(alert()).toBeNull();
        expect(calls(fetch, '/subscriptions')).toHaveLength(0);
    });

    it('shows signing, then confirming, and ignores clicks meanwhile', async () => {
        const sent = deferred<{ signature: Uint8Array }[]>();
        const answer = deferred<Response>();
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockImplementation(() => sent.promise);
        const { fetch } = await setup({
            overrides: { '/subscriptions/sub_1/confirm': () => answer.promise },
        });

        click();
        await waitFor(() => expect(fake.signAndSendTransaction).toHaveBeenCalled());
        expect(stateOf()).toBe('signing');
        expect(button().textContent).toBe('Approve in your wallet');
        expect(button()).toHaveProperty('disabled', true);
        expect(button().getAttribute('aria-busy')).toBe('true');

        await act(async () => sent.resolve([{ signature: fake.signature }]));
        await waitFor(() => expect(stateOf()).toBe('confirming'));
        expect(button().textContent).toBe('Confirming');
        click();

        await act(async () => answer.resolve(json(201, { subscription: active })));
        await waitFor(() => expect(stateOf()).toBe('subscribed'));
        expect(calls(fetch, '/subscriptions')).toHaveLength(1);
    });

    it('finds a wallet not shown as connected, silently', async () => {
        const fake = registerWallet({ name: 'Phantom' });
        await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        expect(fake.connect).toHaveBeenCalledWith({ silent: true });
    });

    it('picks the wallet holding the session account among several', async () => {
        const other = registerWallet({
            name: 'Solflare',
            address: 'Other11111111111111111111111111111111111111',
            connected: true,
        });
        const phantom = registerWallet({ name: 'Phantom', connected: true });
        await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));

        expect(phantom.signAndSendTransaction).toHaveBeenCalledOnce();
        expect(other.signAndSendTransaction).not.toHaveBeenCalled();
    });
});

describe('errors', () => {
    it.each([
        ['/subscriptions', 404, 'This plan does not exist.'],
        ['/subscriptions', 409, 'This plan is not on chain yet.'],
        ['/subscriptions', 409, 'You already hold this plan.'],
        ['/subscriptions', 403, 'Origin not allowed'],
        [
            '/subscriptions/sub_1/transaction',
            409,
            'This wallet holds too little to pay the first period.',
        ],
    ])('shows the API message when %s answers %i', async (path, status, message) => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        const { onSubscribed } = await setup({
            overrides: { [path]: () => json(status, { message, statusCode: status }) },
        });

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(alert()).toBe(message);
        expect(screen.getByRole('alert').hasAttribute('data-mesub-error')).toBe(true);
        expect(button()).toHaveProperty('disabled', false);
        expect(fake.signAndSendTransaction).not.toHaveBeenCalled();
        expect(onSubscribed).not.toHaveBeenCalled();
    });

    it('shows the reason when nothing settled', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { onSubscribed } = await setup({
            overrides: {
                '/subscriptions/sub_1/confirm': () =>
                    json(201, {
                        subscription: pending,
                        reason: 'The transaction expired before it landed.',
                    }),
            },
        });

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(alert()).toBe('The transaction expired before it landed.');
        expect(onSubscribed).not.toHaveBeenCalled();
    });

    it('shows the wallet refusal, and a retry goes through', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { fetch, onSubscribed } = await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));
        expect(alert()).toBe(
            'Phantom did not send the transaction. It said: User rejected the request.',
        );
        expect(button().textContent).toBe('Try again');
        expect(calls(fetch, '/subscriptions/sub_1/confirm')).toHaveLength(0);

        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));
        expect(alert()).toBeNull();
        expect(calls(fetch, '/subscriptions')).toHaveLength(2);
        expect(calls(fetch, '/subscriptions/sub_1/transaction')).toHaveLength(2);
        expect(onSubscribed).toHaveBeenCalledOnce();
    });

    it('refuses a wallet on another account than the session one', async () => {
        const fake = registerWallet({
            name: 'Phantom',
            address: 'Other11111111111111111111111111111111111111',
            connected: true,
        });
        const { fetch } = await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(alert()).toBe(
            'Phantom is on Othe…1111, but you signed in with Wa11…1111. Switch to that account in Phantom, then try again.',
        );
        expect(fake.signAndSendTransaction).not.toHaveBeenCalled();
        expect(calls(fetch, '/subscriptions/sub_1/confirm')).toHaveLength(0);
    });

    it('says so when no wallet can send a transaction', async () => {
        registerWallet({ name: 'Phantom', without: ['solana:signAndSendTransaction'] });
        await setup();

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(alert()).toBe('No wallet in this browser can send a Solana transaction.');
    });

    it('says so when the network fails', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await setup({
            overrides: {
                '/subscriptions': () => Promise.reject(new TypeError('Failed to fetch')),
            },
        });

        click();
        await waitFor(() => expect(stateOf()).toBe('error'));

        expect(alert()).toBe('Could not reach the Mesub API');
    });

    it('says so when Mesub does not answer within 15 seconds, and a retry goes through', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        let hang = true;
        const { fetch, onSubscribed } = await setup({
            overrides: {
                '/subscriptions': () =>
                    hang ? new Promise<never>(() => undefined) : json(201, pending),
            },
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            click();
            await act(() => vi.advanceTimersByTimeAsync(0));
            expect(stateOf()).toBe('signing');

            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(stateOf()).toBe('error');
            expect(alert()).toBe('Mesub did not answer within 15 seconds');
            expect(button()).toHaveProperty('disabled', false);
        } finally {
            vi.useRealTimers();
        }

        hang = false;
        click();
        await waitFor(() => expect(stateOf()).toBe('subscribed'));
        expect(alert()).toBeNull();
        expect(calls(fetch, '/subscriptions')).toHaveLength(2);
        expect(onSubscribed).toHaveBeenCalledOnce();
    });
});

describe('useSubscribe', () => {
    it('runs the same flow for a button of your own', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const fetch = api();
        let result: MesubSubscription | null = null;
        let state!: MesubState;
        function Probe() {
            state = useMesub();
            return null;
        }
        function Own() {
            const { state: status, error, subscribe } = useSubscribe('pro');
            const [label] = useState('Buy');
            return (
                <button
                    type="button"
                    data-status={status}
                    onClick={() => void subscribe().then((done) => (result = done))}
                >
                    {label} {error}
                </button>
            );
        }
        render(
            <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
                <Probe />
                <Own />
            </MesubProvider>,
        );
        await signIn(() => state);

        fireEvent.click(screen.getByRole('button', { name: /Buy/ }));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Buy/ }).dataset.status).toBe('subscribed'),
        );
        expect(result).toEqual(active);
    });
});
