import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MesubProvider, SubscribeButton } from '../src';
import {
    checkout,
    ENDPOINT,
    json,
    made,
    OTHER_WALLET,
    plan,
    prepared,
    refusal,
    server,
    subscription,
    TX_BASE64,
    type Handler,
} from './helpers';
import { registerWallet } from './wallets';

const RESUMABLE =
    'Your subscription to this plan is cancelled but runs until Nov 30, 2026, 14:00 UTC: resume it instead of subscribing again.';
const CLOSABLE =
    'Your cancelled subscription to this plan must be closed first: close it, then subscribe again.';
const LATER =
    'Your cancelled subscription to this plan must be closed first: close it from 2026-12-11T14:00:00.000Z, then subscribe again.';

/** A 409 `subscription_cancelled`, as the routes hand Mesub's body on, with the fields given. */
function cancelled(message: string, fields: Record<string, unknown> = {}): Response {
    return json(409, { error: { code: 'subscription_cancelled', message, ...fields } });
}

const old = (over = {}) =>
    subscription({
        id: 'sub_old',
        status: 'cancelled',
        next_charge_at: null,
        closable: true,
        closable_from: null,
        ...over,
    });
const built = () => json(201, { transaction: TX_BASE64, last_valid_block_height: '100' });

function setup(overrides: Record<string, Handler>) {
    const fetch = server(
        checkout({
            'GET /plans/pro': () => json(200, plan),
            'POST /subscriptions': () => json(201, prepared()),
            'GET /subscriptions/sub_old': () =>
                json(200, { subscription: old(), upcoming: [], payments: [] }),
            'POST /subscriptions/sub_old/resume': built,
            'POST /subscriptions/sub_old/resume/confirm': () =>
                json(201, { subscription: old({ status: 'active' }) }),
            'POST /subscriptions/sub_old/close': built,
            'POST /subscriptions/sub_old/close/confirm': () =>
                json(201, {
                    subscription: old({ status: 'ended', end_reason: 'closed', access: false }),
                }),
            ...overrides,
        }),
    );
    const onSubscribed = vi.fn();
    const wallet = registerWallet();
    render(
        <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
            <SubscribeButton plan="pro" onSubscribed={onSubscribed} />
        </MesubProvider>,
    );
    return { fetch, wallet, onSubscribed };
}

/** The Close button of the screen, not the dialog's own one in its corner. */
const closeOf = (dialog: HTMLElement) =>
    within(dialog)
        .getAllByRole('button', { name: 'Close' })
        .find((button) => button.textContent === 'Close')!;

/** Subscribe, Continue, the wallet: up to what `POST /subscriptions` answers. */
async function toRefusal() {
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with a wallet' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));
    await within(dialog).findByRole('heading', { name: 'Cannot subscribe' });
    return dialog;
}

describe('a checkout refused for a cancelled subscription', () => {
    it('resumes the one that still runs, with one approval, and ends on its done screen', async () => {
        const { fetch, wallet, onSubscribed } = setup({
            'POST /subscriptions': () =>
                cancelled(RESUMABLE, {
                    subscription_id: 'sub_old',
                    can_resume: true,
                    closable_from: null,
                }),
        });

        const dialog = await toRefusal();
        expect(within(dialog).getByRole('alert').textContent).toBe(RESUMABLE);
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        expect(closeOf(dialog)).toBeTruthy();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Resume it' }));

        // The manage dialog's own steps: what resuming does, then the wallet.
        fireEvent.click(await screen.findByRole('button', { name: 'Resume subscription' }));
        expect(await screen.findByRole('heading', { name: 'Subscription resumed' })).toBeTruthy();
        const manage = screen.getByRole('dialog');
        expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
        expect(wallet.signMessage).not.toHaveBeenCalled();
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).toEqual([
            'GET /plans/pro',
            'POST /subscriptions',
            'GET /subscriptions/sub_old',
            // The plan's name and end, as the manage dialog reads them.
            'GET /plans/pro',
            'POST /subscriptions/sub_old/resume',
            'POST /subscriptions/sub_old/resume/confirm',
        ]);
        // Resumed, not subscribed: no new subscription is announced.
        expect(onSubscribed).not.toHaveBeenCalled();

        fireEvent.click(within(manage).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('closes the one that is over, then shows the review again and signs nothing more', async () => {
        let asked = 0;
        const { fetch, wallet } = setup({
            'POST /subscriptions': () =>
                ++asked === 1
                    ? cancelled(CLOSABLE, {
                          subscription_id: 'sub_old',
                          can_resume: false,
                          closable_from: null,
                      })
                    : json(201, prepared()),
        });

        const dialog = await toRefusal();
        expect(within(dialog).getByRole('alert').textContent).toBe(CLOSABLE);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close it and subscribe' }));

        fireEvent.click(await screen.findByRole('button', { name: 'Close subscription' }));

        // Back to the checkout's review, fresh terms, nothing signed for them yet.
        await screen.findByRole('button', { name: 'Sign and pay 2 USDC' });
        const review = screen.getByRole('dialog');
        expect(within(review).getByRole('status').textContent).toBe(
            'Your old subscription is closed. Check the terms, then subscribe.',
        );
        expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
        expect(wallet.signMessage).not.toHaveBeenCalled();
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).toEqual([
            'GET /plans/pro',
            'POST /subscriptions',
            'GET /subscriptions/sub_old',
            // The plan's name and end, as the manage dialog reads them.
            'GET /plans/pro',
            'POST /subscriptions/sub_old/close',
            'POST /subscriptions/sub_old/close/confirm',
            'POST /subscriptions',
        ]);
    });

    it.each([
        [
            'another customer holds it',
            LATER,
            { subscription_id: null, can_resume: false, closable_from: null },
        ],
        [
            'it can only be closed later',
            LATER,
            {
                subscription_id: 'sub_old',
                can_resume: false,
                closable_from: '2026-12-11T14:00:00.000Z',
            },
        ],
        ['an older server names nothing', CLOSABLE, {}],
        ['a field is missing', CLOSABLE, { subscription_id: 'sub_old', closable_from: null }],
    ])("shows Mesub's words and Close only when %s", async (_, message, fields) => {
        const { fetch, wallet } = setup({
            'POST /subscriptions': () => cancelled(message, fields),
        });

        const dialog = await toRefusal();
        expect(within(dialog).getByRole('alert').textContent).toBe(message);
        expect(within(dialog).queryByRole('button', { name: /Resume it|Close it/ })).toBeNull();
        fireEvent.click(closeOf(dialog));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(made(fetch)).toEqual(['GET /plans/pro', 'POST /subscriptions']);
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('reads the fields beside `error` too, as Mesub writes them', async () => {
        setup({
            'POST /subscriptions': () =>
                json(409, {
                    error: { code: 'subscription_cancelled', message: RESUMABLE },
                    subscription_id: 'sub_old',
                    can_resume: true,
                    closable_from: null,
                }),
        });
        const dialog = await toRefusal();
        expect(within(dialog).getByRole('button', { name: 'Resume it' })).toBeTruthy();
    });

    const RESUME = { subscription_id: 'sub_old', can_resume: true, closable_from: null };
    const CLOSE = { subscription_id: 'sub_old', can_resume: false, closable_from: null };

    it('says why the subscription cannot be read, and offers Close', async () => {
        const { wallet } = setup({
            'POST /subscriptions': () => cancelled(RESUMABLE, RESUME),
            'GET /subscriptions/sub_old': () =>
                refusal(404, 'subscription_not_found', 'No such subscription.'),
        });

        const dialog = await toRefusal();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Resume it' }));
        const back = await screen.findByRole('dialog');
        expect(await within(back).findByRole('heading', { name: 'Cannot resume it' })).toBeTruthy();
        expect(within(back).getByRole('alert').textContent).toBe('No such subscription.');
        expect(within(back).queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(closeOf(back)).toBeTruthy();
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('offers Try again when the subscription could not be reached, and reads it again', async () => {
        let reads = 0;
        const { fetch } = setup({
            'POST /subscriptions': () => cancelled(RESUMABLE, RESUME),
            'GET /subscriptions/sub_old': () => {
                if (++reads === 1) throw new TypeError('Failed to fetch');
                return json(200, { subscription: old(), upcoming: [], payments: [] });
            },
        });

        const dialog = await toRefusal();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Resume it' }));
        expect(await within(dialog).findByRole('heading', { name: 'No answer' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe('Could not reach the server.');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));

        expect(await screen.findByRole('button', { name: 'Resume subscription' })).toBeTruthy();
        expect(made(fetch)).toEqual([
            'GET /plans/pro',
            'POST /subscriptions',
            'GET /subscriptions/sub_old',
            'GET /subscriptions/sub_old',
            'GET /plans/pro',
        ]);
    });

    it('shows why the close is refused, not the first refusal, and signs nothing', async () => {
        const { wallet } = setup({
            'POST /subscriptions': () => cancelled(CLOSABLE, CLOSE),
            'POST /subscriptions/sub_old/close': () =>
                refusal(403, 'forbidden', 'This subscription is not yours.'),
        });

        const dialog = await toRefusal();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close it and subscribe' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Close subscription' }));

        // The manage steps give way to the checkout's own dialog.
        expect(await screen.findByRole('heading', { name: 'Cannot close it' })).toBeTruthy();
        const back = screen.getByRole('dialog');
        expect(within(back).getByRole('alert').textContent).toBe('This subscription is not yours.');
        expect(within(back).queryByRole('button', { name: /Close it|Try again/ })).toBeNull();
        expect(closeOf(back)).toBeTruthy();
        fireEvent.click(closeOf(back));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it.each([
        [
            'Mesub is busy',
            () =>
                json(
                    503,
                    { error: { code: 'unavailable', message: 'Busy.' }, retryable: true },
                    { 'Retry-After': '2' },
                ),
            'Busy right now',
            'Too many requests at once. Try again in 2 seconds.',
        ],
        [
            'Mesub says it is retryable',
            () =>
                json(409, {
                    error: { code: 'chain_lagging', message: 'Solana is behind. Try again.' },
                    retryable: true,
                }),
            'Could not close it',
            'Solana is behind. Try again.',
        ],
    ])(
        'offers Try again when the close is refused for now: %s',
        async (_, answer, title, words) => {
            let builds = 0;
            let asked = 0;
            const { fetch, wallet } = setup({
                'POST /subscriptions': () =>
                    ++asked === 1 ? cancelled(CLOSABLE, CLOSE) : json(201, prepared()),
                'POST /subscriptions/sub_old/close': () => (++builds === 1 ? answer() : built()),
            });

            const dialog = await toRefusal();
            fireEvent.click(within(dialog).getByRole('button', { name: 'Close it and subscribe' }));
            fireEvent.click(await screen.findByRole('button', { name: 'Close subscription' }));

            expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
            const back = screen.getByRole('dialog');
            expect(within(back).getByRole('alert').textContent).toBe(words);
            fireEvent.click(within(back).getByRole('button', { name: 'Try again' }));

            // The subscription read again, then the manage steps once more.
            fireEvent.click(await screen.findByRole('button', { name: 'Close subscription' }));
            await screen.findByRole('button', { name: 'Sign and pay 2 USDC' });
            expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
            expect(
                made(fetch).filter((call) => call === 'GET /subscriptions/sub_old'),
            ).toHaveLength(2);
        },
    );

    it.each([
        ['another plan', { plan: 'basic' }],
        ['not cancelled', { status: 'active' }],
        ['another wallet', { wallet: OTHER_WALLET }],
    ])('keeps the first refusal when the subscription read is on %s', async (_, over) => {
        const { fetch, wallet } = setup({
            'POST /subscriptions': () => cancelled(CLOSABLE, CLOSE),
            'GET /subscriptions/sub_old': () =>
                json(200, { subscription: old(over), upcoming: [], payments: [] }),
        });

        const dialog = await toRefusal();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close it and subscribe' }));
        await waitFor(() =>
            expect(
                within(dialog).queryByRole('button', { name: 'Close it and subscribe' }),
            ).toBeNull(),
        );
        expect(
            await within(dialog).findByRole('heading', { name: 'Cannot subscribe' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(CLOSABLE);
        expect(closeOf(dialog)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Close subscription' })).toBeNull();
        expect(made(fetch)).toEqual([
            'GET /plans/pro',
            'POST /subscriptions',
            'GET /subscriptions/sub_old',
        ]);
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('leaves every other 409 as it was', async () => {
        setup({
            'POST /subscriptions': () =>
                json(409, {
                    error: {
                        code: 'already_subscribed',
                        message: 'This wallet is already subscribed to Pro.',
                        // Even with the fields: only a cancelled one has a way out.
                        subscription_id: 'sub_old',
                        can_resume: true,
                        closable_from: null,
                    },
                }),
        });
        const dialog = await toRefusal();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'This wallet is already subscribed to Pro.',
        );
        expect(within(dialog).queryByRole('button', { name: /Resume it|Close it/ })).toBeNull();
        expect(closeOf(dialog)).toBeTruthy();
    });
});
