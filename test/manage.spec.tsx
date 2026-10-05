import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import {
    ManageButton,
    ManageSubscriptions,
    MesubProvider,
    SubscribeButton,
    useSubscriptions,
    type MesubSubscription,
} from '../src';
import {
    base58,
    bodies,
    ENDPOINT,
    json,
    made,
    never,
    OTHER_WALLET,
    plan,
    prepared,
    refusal,
    server,
    subscription,
    TX_BASE64,
    TX_BYTES,
    type Handler,
} from './helpers';
import { paidIn, paymentSaid, pickSubscription, retryOf } from '../src/detail-logic';
import { noteOf } from '../src/subscriptions';
import { registerWallet, type FakeWalletOptions } from './wallets';

const built = () => json(201, { transaction: TX_BASE64, last_valid_block_height: '100' });
const cancelled = subscription({ status: 'cancelled', next_charge_at: null });

/** A server holding one list, which a confirm replaces: the next read shows it. */
function setup({
    held = [subscription()],
    overrides,
    wallet: walletOptions = { connected: true },
    onChanged,
}: {
    held?: MesubSubscription[];
    overrides?: Record<string, Handler>;
    // False: no wallet installed.
    wallet?: FakeWalletOptions | false;
    onChanged?: (subscription: MesubSubscription) => void;
} = {}) {
    let list = held;
    const settle = (next: MesubSubscription) => () => {
        list = list.map((row) => (row.id === next.id ? next : row));
        return json(201, { subscription: next });
    };
    const fetch = server({
        'GET /plans/pro': () => json(200, plan),
        'GET /subscriptions': () => json(200, { subscriptions: list }),
        'POST /subscriptions/sub_1/cancel': built,
        'POST /subscriptions/sub_1/cancel/confirm': settle(cancelled),
        'POST /subscriptions/sub_1/resume': built,
        'POST /subscriptions/sub_1/resume/confirm': settle(subscription()),
        'POST /subscriptions/sub_1/close': built,
        'POST /subscriptions/sub_1/close/confirm': settle(
            subscription({ status: 'ended', end_reason: 'closed', access: false }),
        ),
        ...overrides,
    });
    const wallet = walletOptions === false ? null : registerWallet(walletOptions);
    render(
        <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
            <ManageSubscriptions onChanged={onChanged} />
        </MesubProvider>,
    );
    return { fetch, wallet: wallet! };
}

const row = async (id = 'sub_1') => {
    await screen.findByRole('list', { name: 'Your subscriptions' });
    return document.querySelector<HTMLElement>(`[data-mesub-subscription="${id}"]`)!;
};

/** Click the row's action, then the dialog's own button. */
async function start(action: 'Cancel' | 'Resume' | 'Close') {
    fireEvent.click(within(await row()).getByRole('button', { name: action }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: `${action} subscription` }));
    return dialog;
}

describe('the list', () => {
    it('shows each subscription with its status, plan, date and what it allows now', async () => {
        const { fetch } = setup({
            held: [
                subscription({ id: 'sub_active' }),
                subscription({
                    id: 'sub_late',
                    status: 'unpaid',
                    payment_status: 'late',
                    next_charge_at: null,
                    next_retry_at: '2026-10-06T12:00:00.000Z',
                }),
                subscription({
                    id: 'sub_cancelled',
                    status: 'cancelled',
                    next_charge_at: null,
                    access_until: '2999-01-02T12:00:00.000Z',
                }),
                subscription({
                    id: 'sub_over',
                    status: 'ended',
                    end_reason: 'cancelled',
                    access: false,
                    access_until: null,
                    next_charge_at: null,
                }),
                subscription({
                    id: 'sub_closed',
                    status: 'ended',
                    end_reason: 'closed',
                    access: false,
                    access_until: null,
                    next_charge_at: null,
                }),
                subscription({ id: 'sub_stopped', status: 'stopped', access: false }),
                // Checkouts nobody signed, and rows a newer one replaced: not listed.
                subscription({ id: 'sub_pending', status: 'pending' }),
                subscription({ id: 'sub_expired', status: 'expired' }),
                subscription({ id: 'sub_failed', status: 'failed' }),
                subscription({ id: 'sub_old', status: 'superseded' }),
            ],
        });

        const active = await row('sub_active');
        // The plan's name and price come from the plan, read once for them all.
        expect(await within(active).findByText('Pro')).toBeTruthy();
        // The price stands out, its period follows; the merchant and when it began are said too.
        expect(within(active).getByText('2 USDC')).toBeTruthy();
        expect(active.querySelector('[data-mesub-subscription-price]')?.textContent).toBe(
            '2 USDC every 3 days',
        );
        expect(within(active).getByText(`by ${plan.project_name}`)).toBeTruthy();
        expect(within(active).getByText('Since')).toBeTruthy();
        expect(within(active).getByText('Active')).toBeTruthy();
        expect(within(active).getByText('Next charge')).toBeTruthy();
        expect(within(active).getByText('Wa11…1111')).toBeTruthy();
        expect(within(active).getByRole('button', { name: 'Cancel' })).toBeTruthy();

        const late = await row('sub_late');
        expect(within(late).getByText('Payment late')).toBeTruthy();
        expect(within(late).getByText('Next try')).toBeTruthy();
        expect(within(late).getByRole('button', { name: 'Cancel' })).toBeTruthy();

        const stopping = await row('sub_cancelled');
        expect(within(stopping).getByText('Cancelled')).toBeTruthy();
        expect(within(stopping).getByText('Access until')).toBeTruthy();
        expect(within(stopping).getByRole('button', { name: 'Resume' })).toBeTruthy();

        const over = await row('sub_over');
        expect(within(over).getByText('Ended')).toBeTruthy();
        expect(within(over).getByRole('button', { name: 'Close' })).toBeTruthy();

        // Closed already: nothing left to do.
        expect(within(await row('sub_closed')).queryByRole('button')).toBeNull();
        expect(
            within(await row('sub_stopped')).getByRole('button', { name: 'Cancel' }),
        ).toBeTruthy();

        expect(document.querySelectorAll('[data-mesub-subscription]')).toHaveLength(6);
        expect(made(fetch).filter((call) => call === 'GET /plans/pro')).toHaveLength(1);
        expect(fetch.mock.calls[0]![1].credentials).toBe('include');
    });

    it('offers Close on a cancellation whose end has passed', async () => {
        setup({
            held: [
                subscription({
                    status: 'cancelled',
                    next_charge_at: null,
                    access_until: '2020-01-01T00:00:00.000Z',
                }),
            ],
        });

        expect(within(await row()).getByRole('button', { name: 'Close' })).toBeTruthy();
    });

    it('falls back on the slug when the plan cannot be read', async () => {
        setup({
            overrides: { 'GET /plans/pro': () => refusal(404, 'plan_not_found', 'No such plan.') },
        });

        expect(within(await row()).getByText('pro')).toBeTruthy();
    });

    it('marks a paused seat', async () => {
        setup({ held: [subscription({ paused: true })] });

        const parked = await row();

        expect(within(parked).getByText('Parked')).toBeTruthy();
        expect(within(parked).getByText('Parked: nothing is charged while it is.')).toBeTruthy();
    });

    it('says to sign in on the site on a 401, and lists nothing', async () => {
        const { fetch } = setup({
            overrides: {
                'GET /subscriptions': () => refusal(401, 'unauthenticated', 'Sign in first.'),
            },
        });

        expect(
            await screen.findByText('Sign in on this site to see your subscriptions.'),
        ).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
        expect(
            document.querySelector('[data-mesub-subscriptions]')!.getAttribute('data-mesub-state'),
        ).toBe('signed-out');
        expect(made(fetch)).toEqual(['GET /subscriptions']);
    });

    it('says so when there is none', async () => {
        setup({ held: [] });

        expect(await screen.findByText('You have no subscription yet.')).toBeTruthy();
    });

    it('shows a failed read, and reads again on Try again', async () => {
        let failed = false;
        const { fetch } = setup({
            overrides: {
                'GET /subscriptions': () => {
                    if (failed) return json(200, { subscriptions: [subscription()] });
                    failed = true;
                    throw new TypeError('Failed to fetch');
                },
            },
        });

        expect((await screen.findByRole('alert')).textContent).toBe('Could not reach the server.');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await row()).toBeTruthy();
        expect(made(fetch).filter((call) => call === 'GET /subscriptions')).toHaveLength(2);
    });

    it('gives up on the read after 15 seconds', async () => {
        vi.useFakeTimers();
        setup({ overrides: { 'GET /subscriptions': never } });

        expect(screen.getByRole('status').textContent).toBe('Loading your subscriptions');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        vi.useRealTimers();

        expect((await screen.findByRole('alert')).textContent).toBe('No answer within 15 seconds.');
    });

    it('reads again once a subscription was made through the button', async () => {
        const fetch = server({
            'GET /plans/pro': () => json(200, plan),
            'GET /subscriptions': () => json(200, { subscriptions: [] }),
            'POST /subscriptions': () => json(201, prepared()),
            'POST /subscriptions/sub_1/submit': () => json(201, { subscription: subscription() }),
        });
        registerWallet();
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
                <SubscribeButton plan="pro" />
                <ManageSubscriptions />
            </MesubProvider>,
        );
        await screen.findByText('You have no subscription yet.');

        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(
            await within(dialog).findByRole('button', { name: 'Continue with a wallet' }),
        );
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' }));
        await within(dialog).findByRole('heading', { name: 'You are subscribed' });

        await waitFor(() =>
            expect(made(fetch).filter((call) => call === 'GET /subscriptions')).toHaveLength(2),
        );
    });
});

describe('cancel, resume, close: the wallet signs and sends, the server confirms', () => {
    it.each([
        ['Cancel', 'cancel', subscription(), 'Subscription cancelled', 'Resume'],
        [
            'Resume',
            'resume',
            subscription({ ...cancelled, access_until: '2999-01-01T00:00:00.000Z' }),
            'Subscription resumed',
            'Cancel',
        ],
        [
            'Close',
            'close',
            subscription({ status: 'ended', end_reason: 'cancelled', access: false }),
            'Subscription closed',
            null,
        ],
    ] as const)(
        '%s: builds, has the wallet send it, confirms, and reads the list again',
        async (label, action, held, done, next) => {
            const onChanged = vi.fn();
            const { fetch, wallet } = setup({ held: [held], onChanged });

            const dialog = await start(label);
            expect(await within(dialog).findByRole('heading', { name: done })).toBeTruthy();
            expect(dialog.getAttribute('data-mesub-step')).toBe('done');

            // Signed AND sent by the wallet, on the provider's chain: never the subscribe order.
            expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
            expect(wallet.signAndSendTransaction.mock.calls[0]![0]).toEqual({
                account: wallet.account,
                chain: 'solana:devnet',
                transaction: TX_BYTES,
            });
            expect(wallet.signTransaction).not.toHaveBeenCalled();
            expect(wallet.signMessage).not.toHaveBeenCalled();
            expect(wallet.disconnect).not.toHaveBeenCalled();
            // Already authorised on this site: found silently, no prompt.
            expect(wallet.connect).toHaveBeenCalledTimes(1);
            expect(wallet.connect).toHaveBeenCalledWith({ silent: true });

            expect(bodies(fetch, `POST /subscriptions/sub_1/${action}`)).toEqual([{}]);
            expect(bodies(fetch, `POST /subscriptions/sub_1/${action}/confirm`)).toEqual([
                { signature: base58(wallet.signature) },
            ]);
            for (const [, init] of fetch.mock.calls) expect(init.credentials).toBe('include');
            expect(
                within(dialog).getByRole('link', { name: 'View transaction' }).getAttribute('href'),
            ).toBe(`https://explorer.solana.com/tx/${base58(wallet.signature)}?cluster=devnet`);

            // The list is read again, and the row shows what it allows now.
            await waitFor(() =>
                expect(
                    made(fetch).filter((call) => call === 'GET /subscriptions').length,
                ).toBeGreaterThan(1),
            );
            fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            if (next)
                expect(await within(await row()).findByRole('button', { name: next })).toBeTruthy();
            else
                await waitFor(async () =>
                    expect(within(await row()).queryByRole('button')).toBeNull(),
                );
            expect(onChanged).toHaveBeenCalledTimes(1);
            expect(onChanged.mock.calls[0]![0].id).toBe('sub_1');
        },
    );

    it('says what cancelling does before anything is signed, and leaves on Keep it', async () => {
        const { fetch, wallet } = setup();

        fireEvent.click(within(await row()).getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');

        expect(await within(dialog).findByRole('heading', { name: 'Cancel Pro?' })).toBeTruthy();
        expect(
            within(dialog).getByText(/^You keep access until .+\. Nothing more is charged\.$/),
        ).toBeTruthy();
        expect(within(dialog).getByText('Wa11…1111')).toBeTruthy();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(wallet.connect).not.toHaveBeenCalled();
        expect(made(fetch)).toEqual(['GET /subscriptions', 'GET /plans/pro']);
    });

    it('builds and sends once on a double click', async () => {
        const { fetch, wallet } = setup();

        fireEvent.click(within(await row()).getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');
        const go = within(dialog).getByRole('button', { name: 'Cancel subscription' });
        fireEvent.click(go);
        fireEvent.click(go);
        await within(dialog).findByRole('heading', { name: 'Subscription cancelled' });

        expect(bodies(fetch, 'POST /subscriptions/sub_1/cancel')).toHaveLength(1);
        expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    });
});

describe('the wallet that pays', () => {
    it('asks which wallet when none shows the paying account yet, then connects it', async () => {
        const { fetch, wallet } = setup({ wallet: { connected: false } });
        // Not authorised on this site: a silent connect shares nothing.
        wallet.connect.mockResolvedValueOnce({ accounts: [] });

        const dialog = await start('Cancel');
        const pick = await within(dialog).findByRole('button', { name: 'Fake Wallet' });
        expect(
            within(dialog).getByText('The one that pays this subscription: Wa11…1111.'),
        ).toBeTruthy();
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/cancel');

        fireEvent.click(pick);
        expect(
            await within(dialog).findByRole('heading', { name: 'Subscription cancelled' }),
        ).toBeTruthy();
        expect(wallet.connect).toHaveBeenCalledTimes(2);
        expect(wallet.connect).toHaveBeenLastCalledWith(undefined);
        expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    });

    it('asks which wallet when one never answers the silent connect', async () => {
        const { wallet } = setup();
        wallet.connect.mockReturnValueOnce(new Promise(() => undefined));

        fireEvent.click(within(await row()).getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');
        vi.useFakeTimers();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_000);
        });
        vi.useRealTimers();

        expect(await within(dialog).findByRole('button', { name: 'Fake Wallet' })).toBeTruthy();
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a wallet on another account: nothing is built, nothing is signed', async () => {
        const { fetch, wallet } = setup({ wallet: { address: OTHER_WALLET } });

        const dialog = await start('Cancel');
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(await within(dialog).findByRole('heading', { name: 'Wrong wallet' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Fake Wallet is on Othe…1111, and this subscription is paid from Wa11…1111. Switch to that account in your wallet, then try again.',
        );
        expect(within(dialog).getByText('Nothing changed.')).toBeTruthy();
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/cancel');

        fireEvent.click(within(dialog).getByRole('button', { name: 'Use another wallet' }));
        expect(await within(dialog).findByRole('button', { name: /Fake Wallet/ })).toBeTruthy();
    });

    it('offers to install one when no wallet is there', async () => {
        const { fetch } = setup({ wallet: false });

        const dialog = await start('Cancel');

        expect(
            await within(dialog).findByRole('heading', { name: 'No Solana wallet found' }),
        ).toBeTruthy();
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/cancel');
    });

    it('says what a wallet that cannot send lacks', async () => {
        setup({ wallet: { name: 'Old Wallet', without: ['solana:signAndSendTransaction'] } });

        const dialog = await start('Cancel');

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'Old Wallet cannot send a transaction.',
        );
    });

    it('shows a refusal to connect', async () => {
        const { wallet } = setup({ wallet: { connected: false } });
        wallet.connect
            .mockResolvedValueOnce({ accounts: [] })
            .mockRejectedValueOnce(new Error('User rejected the request.'));

        const dialog = await start('Cancel');
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'Fake Wallet said: User rejected the request.',
        );
    });

    it('stops when the wallet refuses the transaction, and builds a fresh one to try again', async () => {
        const { fetch, wallet } = setup();
        wallet.signAndSendTransaction.mockRejectedValueOnce(
            new Error('User rejected the request.'),
        );

        const dialog = await start('Cancel');

        expect(await within(dialog).findByRole('heading', { name: 'Not approved' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Fake Wallet said: User rejected the request.',
        );
        expect(within(dialog).getByText('Nothing changed.')).toBeTruthy();
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/cancel/confirm');

        fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
        expect(
            await within(dialog).findByRole('heading', { name: 'Subscription cancelled' }),
        ).toBeTruthy();
        expect(bodies(fetch, 'POST /subscriptions/sub_1/cancel')).toHaveLength(2);
    });
});

describe("what the merchant's server answers", () => {
    it('says nothing changed when the confirm carries a reason', async () => {
        const onChanged = vi.fn();
        setup({
            onChanged,
            overrides: {
                'POST /subscriptions/sub_1/cancel/confirm': () =>
                    json(201, {
                        subscription: subscription(),
                        reason: 'The transaction expired before it landed.',
                    }),
            },
        });

        const dialog = await start('Cancel');

        expect(
            await within(dialog).findByRole('heading', { name: 'It did not go through' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'The transaction expired before it landed.',
        );
        expect(within(dialog).getByText('Nothing changed.')).toBeTruthy();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onChanged).not.toHaveBeenCalled();
    });

    it("shows Mesub's own words on a 409, and asks the wallet nothing", async () => {
        const { wallet } = setup({
            overrides: {
                'POST /subscriptions/sub_1/cancel': () =>
                    refusal(409, 'not_cancellable', 'This subscription is already cancelled.'),
            },
        });

        const dialog = await start('Cancel');

        expect(
            await within(dialog).findByRole('heading', { name: 'Cannot cancel it' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'This subscription is already cancelled.',
        );
        expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('says to sign in on the site on a 401, and asks the wallet nothing', async () => {
        const { wallet } = setup({
            overrides: {
                'POST /subscriptions/sub_1/cancel': () =>
                    refusal(401, 'unauthenticated', 'Sign in first.'),
            },
        });

        const dialog = await start('Cancel');

        expect(await within(dialog).findByRole('heading', { name: 'Sign in first' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'You are not signed in on this site. Sign in here first, then try again.',
        );
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('offers to try again when the build fails on the network', async () => {
        let failed = false;
        setup({
            overrides: {
                'POST /subscriptions/sub_1/cancel': () => {
                    if (failed) return built();
                    failed = true;
                    throw new TypeError('Failed to fetch');
                },
            },
        });

        const dialog = await start('Cancel');

        expect(await within(dialog).findByRole('heading', { name: 'No answer' })).toBeTruthy();
        expect(within(dialog).getByText('Nothing changed.')).toBeTruthy();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
        expect(
            await within(dialog).findByRole('heading', { name: 'Subscription cancelled' }),
        ).toBeTruthy();
    });

    it('gives up on the build after 15 seconds', async () => {
        setup({ overrides: { 'POST /subscriptions/sub_1/cancel': never } });

        fireEvent.click(within(await row()).getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByRole('heading', { name: 'Cancel Pro?' });
        vi.useFakeTimers();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        vi.useRealTimers();

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'No answer within 15 seconds.',
        );
    });

    it('waits 90 seconds on the confirm, then checks again with the same signature', async () => {
        let hang = true;
        const { fetch, wallet } = setup({
            overrides: {
                'POST /subscriptions/sub_1/cancel/confirm': () =>
                    hang ? never() : json(201, { subscription: cancelled }),
            },
        });

        fireEvent.click(within(await row()).getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByRole('heading', { name: 'Cancel Pro?' });
        vi.useFakeTimers();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(89_000);
        });
        expect(within(dialog).getByRole('heading', { name: 'Confirming on Solana' })).toBeTruthy();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        vi.useRealTimers();

        expect(
            await within(dialog).findByRole('heading', { name: 'Still confirming' }),
        ).toBeTruthy();
        expect(within(dialog).getByText('The transaction may still land.')).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: /Back|Try again/ })).toBeNull();

        hang = false;
        fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
        expect(
            await within(dialog).findByRole('heading', { name: 'Subscription cancelled' }),
        ).toBeTruthy();

        // The wallet sent once; the same signature is confirmed twice.
        expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
        expect(bodies(fetch, 'POST /subscriptions/sub_1/cancel/confirm')).toEqual([
            { signature: base58(wallet.signature) },
            { signature: base58(wallet.signature) },
        ]);
    });
});

describe('useSubscriptions, for a list of your own', () => {
    function Own() {
        const { state, subscriptions, error, manage } = useSubscriptions();
        const [answer, setAnswer] = useState('none');
        return (
            <>
                <output>
                    {state}:{error ?? '-'}:{answer}
                </output>
                {subscriptions.map((held) => (
                    <button
                        key={held.id}
                        type="button"
                        onClick={() =>
                            void manage(held.id).then((result) =>
                                setAnswer(result ? result.status : 'null'),
                            )
                        }
                    >
                        {held.id} {held.status} {held.action ?? 'nothing'}
                    </button>
                ))}
            </>
        );
    }

    function own(held: MesubSubscription[]) {
        let list = held;
        const fetch = server({
            'GET /plans/pro': () => json(200, plan),
            'GET /subscriptions': () => json(200, { subscriptions: list }),
            'POST /subscriptions/sub_1/cancel': built,
            'POST /subscriptions/sub_1/cancel/confirm': () => {
                list = [cancelled];
                return json(201, { subscription: cancelled });
            },
        });
        registerWallet({ connected: true });
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
                <Own />
            </MesubProvider>,
        );
        return fetch;
    }

    it('gives each subscription with what it allows, and runs it through the dialog', async () => {
        own([subscription()]);

        expect(screen.getByRole('status').textContent).toBe('loading:-:none');
        fireEvent.click(await screen.findByRole('button', { name: 'sub_1 active cancel' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
        await within(dialog).findByRole('heading', { name: 'Subscription cancelled' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toBe('ready:-:cancelled'),
        );
        expect(await screen.findByRole('button', { name: 'sub_1 cancelled resume' })).toBeTruthy();
    });

    it('resolves with null when the dialog is closed, or when nothing is allowed', async () => {
        own([
            subscription(),
            subscription({ id: 'sub_2', status: 'ended', end_reason: 'closed', access: false }),
        ]);

        fireEvent.click(await screen.findByRole('button', { name: 'sub_2 ended nothing' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('ready:-:null'));
        expect(screen.queryByRole('dialog')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'sub_1 active cancel' }));
        fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
});

describe('ManageButton', () => {
    const DAY = 86_400_000;
    const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
    const SIGNATURE = base58(new Uint8Array(64).fill(7));

    function mount({
        held = [subscription()],
        detail,
        plan: slug,
        children,
    }: {
        held?: MesubSubscription[];
        // What GET /subscriptions/:id answers; left out, the route does not exist.
        detail?: unknown;
        plan?: string;
        children?: string;
    } = {}) {
        const fetch = server({
            'GET /plans/pro': () => json(200, plan),
            'GET /subscriptions': () => json(200, { subscriptions: held }),
            'GET /subscriptions/sub_1': () =>
                detail === undefined
                    ? refusal(404, 'not_found', 'Nothing here.')
                    : json(200, detail),
            'POST /subscriptions/sub_1/cancel': built,
        });
        registerWallet({ connected: true });
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
                <ManageButton plan={slug}>{children}</ManageButton>
            </MesubProvider>,
        );
        return fetch;
    }

    const open = async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
        return screen.findByRole('dialog');
    };

    it('reads nothing until it is clicked, then shows the one subscription', async () => {
        const fetch = mount();

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fetch).not.toHaveBeenCalled();

        const dialog = await open();

        expect(await within(dialog).findByRole('heading', { name: 'Pro' })).toBeTruthy();
        expect(within(dialog).getByText(`by ${plan.project_name}`)).toBeTruthy();
        expect(within(dialog).getByText('Active')).toBeTruthy();
        expect(within(dialog).getByText('Wa11…1111')).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
    });

    it('takes its own words', () => {
        mount({ children: 'Billing' });

        expect(screen.getByRole('button', { name: 'Billing' })).toBeTruthy();
    });

    it('lists what comes next, then what was charged, newest first, each paid one with its receipt', async () => {
        mount({
            detail: {
                subscription: subscription(),
                upcoming: [
                    { kind: 'charge', due_at: iso(3), amount: '2000000', amount_display: '2' },
                ],
                payments: [
                    {
                        attempted_at: iso(0),
                        outcome: 'paid',
                        amount: '2000000',
                        reason: null,
                        signature: SIGNATURE,
                    },
                    {
                        attempted_at: iso(-3),
                        outcome: 'rejected',
                        amount: '2000000',
                        reason: 'insufficient-balance',
                        signature: SIGNATURE,
                    },
                    {
                        attempted_at: iso(-3),
                        outcome: 'REFUNDED',
                        amount: '2000000',
                        reason: null,
                        signature: null,
                    },
                ],
            },
        });
        const dialog = await open();

        const lines = await waitFor(() => {
            const found = within(dialog).getAllByRole('listitem');
            expect(found).toHaveLength(4);
            return found;
        });

        expect(lines[0]!.getAttribute('data-mesub-payment')).toBe('upcoming');
        expect(within(lines[0]!).getByText('Next charge')).toBeTruthy();
        expect(lines[1]!.getAttribute('data-mesub-payment')).toBe('good');
        // Only a paid one links to its transaction.
        expect(within(lines[1]!).getByRole('link').getAttribute('href')).toContain(SIGNATURE);
        expect(within(lines[2]!).getByText('Missed, low balance')).toBeTruthy();
        expect(within(lines[2]!).queryByRole('link')).toBeNull();
        // An outcome this version does not know is shown as named, never as paid.
        expect(within(lines[3]!).getByText('refunded')).toBeTruthy();
        expect(lines[3]!.getAttribute('data-mesub-payment')).toBe('none');
        // What comes next is said once: not as a fact above too.
        expect(within(dialog).getAllByText('Next charge')).toHaveLength(1);
    });

    const paid = (attempted_at: string) => ({
        attempted_at,
        outcome: 'paid',
        amount: '2000000',
        reason: null,
        signature: SIGNATURE,
    });

    it('groups the payments under one toggle: Incoming, then Past', async () => {
        mount({
            detail: {
                subscription: subscription(),
                upcoming: [
                    { kind: 'charge', due_at: iso(3), amount: '2000000', amount_display: '2' },
                ],
                payments: [paid(iso(0))],
                paid: { count: 1, amount: '2000000' },
            },
        });
        const dialog = await open();

        const toggle = await within(dialog).findByText('Payments');
        expect(toggle.tagName).toBe('SUMMARY');
        const groups = within(toggle.parentElement!).getAllByRole('heading', { level: 3 });
        expect(groups.map((heading) => heading.textContent)).toEqual(['Incoming', 'Past']);
    });

    it("shows the total the server gives, in the plan's token", async () => {
        mount({
            detail: {
                subscription: subscription(),
                upcoming: [],
                payments: [paid(iso(0))],
                paid: { count: 4, amount: '8000000' },
            },
        });
        const dialog = await open();

        const label = await within(dialog).findByText('Total paid');
        expect(label.nextElementSibling?.textContent).toBe('8 USDC');
    });

    it('takes the sum of the charges listed as the total only while the list is whole', async () => {
        mount({
            detail: {
                subscription: subscription(),
                upcoming: [],
                payments: [paid(iso(0)), paid(iso(-3))],
                listed_paid: { count: 2, amount: '4000000' },
            },
        });
        const dialog = await open();

        expect(
            (await within(dialog).findByText('Total paid')).nextElementSibling?.textContent,
        ).toBe('4 USDC');
    });

    it('shows no total when the list may be cut short and the server gives none', async () => {
        mount({
            detail: {
                subscription: subscription(),
                upcoming: [],
                payments: [0, -3, -6, -9, -12].map((days) => paid(iso(days))),
                listed_paid: { count: 5, amount: '10000000' },
            },
        });
        const dialog = await open();

        await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(5));
        expect(within(dialog).queryByText('Total paid')).toBeNull();
    });

    it('stands without payments on a server that has no such route', async () => {
        mount();
        const dialog = await open();

        expect(await within(dialog).findByRole('heading', { name: 'Pro' })).toBeTruthy();
        expect(within(dialog).queryByText('Payments')).toBeNull();
        // The next charge is still said, as a fact.
        expect(within(dialog).getByText('Next charge')).toBeTruthy();
    });

    it('stands without them when the server could not read them', async () => {
        mount({ detail: { subscription: subscription(), upcoming: [], payments: null } });
        const dialog = await open();

        expect(await within(dialog).findByRole('heading', { name: 'Pro' })).toBeTruthy();
        expect(within(dialog).queryByRole('listitem')).toBeNull();
    });

    it('says so when the customer has no subscription to that plan', async () => {
        mount({ held: [subscription({ plan: 'team' })], plan: 'pro' });
        const dialog = await open();

        expect(
            await within(dialog).findByRole('heading', { name: 'No subscription yet' }),
        ).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    });

    it('steps aside for its action, and comes back when that one is left', async () => {
        mount();
        const dialog = await open();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Cancel subscription' }));

        // One dialog at a time: the cancel's own.
        fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
        await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));

        expect(await screen.findByRole('heading', { name: 'Pro' })).toBeTruthy();
    });

    it('closes on Done, and opens again', async () => {
        mount();

        fireEvent.click(within(await open()).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        expect(await open()).toBeTruthy();
    });
});

describe('which subscription the window is about', () => {
    const at = (id: string, status: MesubSubscription['status'], createdAt: string, slug = 'pro') =>
        subscription({ id, status, created_at: createdAt, plan: slug });

    it('takes the one to that plan, a live one before an ended one', () => {
        const rows = [
            at('ended_new', 'ended', '2026-10-03T00:00:00.000Z'),
            at('active_old', 'active', '2026-09-01T00:00:00.000Z'),
            at('other_plan', 'active', '2026-10-04T00:00:00.000Z', 'team'),
        ];

        expect(pickSubscription(rows, 'pro')?.id).toBe('active_old');
        expect(pickSubscription(rows, 'team')?.id).toBe('other_plan');
        // No plan named: the newest live one, whatever its plan.
        expect(pickSubscription(rows)?.id).toBe('other_plan');
    });

    it('takes the newest ended one when nothing is live', () => {
        const rows = [
            at('older', 'ended', '2026-08-01T00:00:00.000Z'),
            at('newer', 'ended', '2026-09-01T00:00:00.000Z'),
        ];

        expect(pickSubscription(rows, 'pro')?.id).toBe('newer');
    });

    it.each(['pending', 'expired', 'failed', 'superseded'] as const)(
        'never takes a %s row',
        (status) => {
            expect(
                pickSubscription([at('x', status, '2026-10-01T00:00:00.000Z')], 'pro'),
            ).toBeNull();
        },
    );

    it('answers null for nothing, and for no subscription to that plan', () => {
        expect(pickSubscription([], 'pro')).toBeNull();
        expect(
            pickSubscription([at('x', 'active', '2026-10-01T00:00:00.000Z', 'team')], 'pro'),
        ).toBeNull();
    });
});

describe('how a charge reads', () => {
    it.each([
        [{ retry_number: 2, retries_allowed: 3 }, '2 / 3'],
        [{ retry_number: null, retries_allowed: 3 }, null],
        [{ retry_number: 1, retries_allowed: 0 }, null],
        [{ retry_number: 1, retries_allowed: null }, null],
        [{}, null],
    ])('counts the retry of %j as %j', (of, said) => {
        expect(retryOf(of)).toBe(said);
    });

    it.each([
        [
            { outcome: 'paid', reason: null },
            { label: 'Paid', tone: 'good' },
        ],
        [
            { outcome: 'rejected', reason: 'insufficient-balance' },
            { label: 'Missed, low balance', tone: 'bad' },
        ],
        [
            { outcome: 'rejected', reason: 'something-new' },
            { label: 'Missed', tone: 'bad' },
        ],
        [
            { outcome: 'rejected', reason: null },
            { label: 'Missed', tone: 'bad' },
        ],
        [
            { outcome: 'skipped', reason: null },
            { label: 'Skipped', tone: 'none' },
        ],
        [
            { outcome: 'blocked', reason: 'terms-missing' },
            { label: 'Not charged', tone: 'none' },
        ],
        [
            { outcome: 'charged_back', reason: null },
            { label: 'charged back', tone: 'none' },
        ],
    ])('says %j as %j', (payment, said) => {
        expect(paymentSaid(payment)).toEqual(said);
    });

    it("writes an amount in the plan's token, and nothing when the plan is unknown", () => {
        const format = (amount: string, decimals: number) => `${Number(amount) / 10 ** decimals}`;

        expect(paidIn('2000000', { decimals: 6, symbol: 'USDC' }, format)).toBe('2 USDC');
        expect(paidIn('2000000', { decimals: 6, symbol: null }, format)).toBe('2');
        expect(paidIn('2000000', undefined, format)).toBeNull();
        expect(paidIn('2.5', { decimals: 6, symbol: 'USDC' }, format)).toBeNull();
    });
});

describe('what a card says under its dates', () => {
    const held = (
        over: Partial<MesubSubscription>,
        action: 'cancel' | 'resume' | 'close' | null,
    ) => ({
        ...subscription(over),
        action,
    });

    it('says nothing on a healthy one', () => {
        expect(noteOf(held({}, 'cancel'))).toBeNull();
    });

    it.each([
        [{ status: 'unpaid', next_retry_at: '2026-10-05T00:00:00.000Z' }, /before the next try/],
        [{ status: 'unpaid', next_retry_at: null }, /Add funds to the wallet\.$/],
        [{ status: 'unpaid', late_reason: 'insufficient_balance' }, /Add funds to the wallet/],
        // One this version does not know: read as no reason.
        [{ status: 'unpaid', late_reason: 'account_frozen' }, /Add funds to the wallet/],
        [
            {
                status: 'unpaid',
                late_reason: 'approval_revoked',
                next_retry_at: '2026-10-05T00:00:00.000Z',
            },
            /no longer lets Mesub charge it: adding funds will not fix it\.$/,
        ],
        [{ status: 'unpaid', late_reason: 'authority_closed' }, /can no longer be charged\.$/],
        // Only a late one has a reason to tell.
        [{ status: 'stopped', late_reason: 'approval_revoked' }, /^Stopped after missed payments/],
        [{ status: 'cancelled' }, /Resume before the end/],
        [{ status: 'stopped' }, /Stopped after missed payments/],
        [{ paused: true }, /Parked/],
    ] as const)('explains %j', (over, text) => {
        expect(noteOf(held(over as Partial<MesubSubscription>, null))).toMatch(text);
    });

    it('offers the deposit back on an ended one only when it can be closed', () => {
        expect(noteOf(held({ status: 'ended' }, 'close'))).toMatch(/deposit back/);
        expect(noteOf(held({ status: 'ended' }, null))).toBe('Ended. Nothing more is charged.');
    });
});
