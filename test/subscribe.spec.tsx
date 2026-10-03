import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MesubProvider, SubscribeButton, useSubscribe, type SolanaChain } from '../src';
import {
    base58,
    base64,
    bodies,
    ENDPOINT,
    json,
    made,
    never,
    plan,
    prepared,
    refusal,
    server,
    subscription,
    TERMS,
    TX_BYTES,
    WALLET,
    type Handler,
} from './helpers';
import { registerWallet, signedBy, type FakeWalletOptions } from './wallets';

const routes: Record<string, Handler> = {
    'GET /plans/pro': () => json(200, plan),
    'POST /subscriptions': () => json(201, prepared()),
    'POST /subscriptions/sub_1/submit': () => json(201, { subscription: subscription() }),
};

function setup({
    overrides,
    chain,
    wallet: walletOptions = {},
}: {
    overrides?: Record<string, Handler>;
    chain?: SolanaChain;
    // False: no wallet installed.
    wallet?: FakeWalletOptions | false;
} = {}) {
    const fetch = server({ ...routes, ...overrides });
    const onSubscribed = vi.fn();
    const wallet = walletOptions === false ? null : registerWallet(walletOptions);
    render(
        <MesubProvider endpoint={ENDPOINT} chain={chain} fetch={fetch}>
            <SubscribeButton plan="pro" onSubscribed={onSubscribed} />
        </MesubProvider>,
    );
    return { fetch, onSubscribed, wallet: wallet! };
}

const button = () => screen.getByRole('button', { name: /^(Subscribe|Subscribed)$/ });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

/** Click Subscribe, then Continue: the wallet list is up. */
async function toWallets() {
    fireEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with a wallet' }));
    return dialog;
}

/** Up to the review: the wallet connected and the server prepared the subscription. */
async function toReview(name = 'Fake Wallet') {
    const dialog = await toWallets();
    fireEvent.click(await within(dialog).findByRole('button', { name }));
    await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' });
    return dialog;
}

const sign = () => click('Sign and pay 2 USDC');

describe('subscribing, from the click to Done', () => {
    it('shows the plan, connects, shows the costs, signs the terms then the transaction, and submits', async () => {
        const { fetch, wallet, onSubscribed } = setup();

        fireEvent.click(button());
        const dialog = await screen.findByRole('dialog');

        // The plan first: its name, price and period, before any wallet.
        expect(await within(dialog).findByRole('heading', { name: 'Pro' })).toBeTruthy();
        expect(within(dialog).getByText('2 USDC')).toBeTruthy();
        expect(within(dialog).getByText('every 3 days')).toBeTruthy();
        expect(within(dialog).getByText('Fraise')).toBeTruthy();
        expect(within(dialog).getByText('Test network')).toBeTruthy();
        expect(dialog.getAttribute('data-mesub-step')).toBe('plan');
        expect(made(fetch)).toEqual(['GET /plans/pro']);

        click('Continue with a wallet');
        expect(dialog.getAttribute('data-mesub-step')).toBe('wallet');
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        // The costs, before the wallet is asked to sign anything.
        await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' });
        expect(dialog.getAttribute('data-mesub-step')).toBe('review');
        // One line: the whole cost, and the part that comes back.
        expect(
            within(dialog).getByText(
                'Plus 0.00354928 SOL in network costs, of which 0.00353928 SOL comes back when you close it.',
            ),
        ).toBeTruthy();
        expect(within(dialog).queryByText('Due today')).toBeNull();
        expect(within(dialog).getByText('Wa11…1111')).toBeTruthy();
        expect(within(dialog).getByText(TERMS, { normalizer: (text) => text })).toBeTruthy();
        expect(wallet.signMessage).not.toHaveBeenCalled();
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(bodies(fetch, 'POST /subscriptions')).toEqual([{ plan: 'pro', wallet: WALLET }]);

        sign();
        expect(
            await within(dialog).findByRole('heading', { name: 'You are subscribed' }),
        ).toBeTruthy();
        expect(dialog.getAttribute('data-mesub-step')).toBe('subscribed');

        // The terms first, over their UTF-8 bytes, then the transaction, signed and not sent.
        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
        expect(wallet.signMessage.mock.calls[0]![0]).toEqual({
            account: wallet.account,
            message: new TextEncoder().encode(TERMS),
        });
        expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
        expect(wallet.signTransaction.mock.calls[0]![0]).toEqual({
            account: wallet.account,
            chain: 'solana:devnet',
            transaction: TX_BYTES,
        });
        expect(wallet.signMessage.mock.invocationCallOrder[0]).toBeLessThan(
            wallet.signTransaction.mock.invocationCallOrder[0]!,
        );
        expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
        expect(wallet.disconnect).not.toHaveBeenCalled();

        // Exactly these requests, with the cookie, and what the wallet signed.
        expect(made(fetch)).toEqual([
            'GET /plans/pro',
            'POST /subscriptions',
            'POST /subscriptions/sub_1/submit',
        ]);
        expect(bodies(fetch, 'POST /subscriptions/sub_1/submit')).toEqual([
            {
                transaction: base64(signedBy(wallet.signature, TX_BYTES)),
                terms_signature: base58(wallet.signature),
            },
        ]);
        for (const [, init] of fetch.mock.calls) expect(init.credentials).toBe('include');

        expect(onSubscribed).toHaveBeenCalledTimes(1);
        expect(onSubscribed).toHaveBeenCalledWith(subscription());
        // The wallet is the transaction's first signer here: its signature is the receipt.
        const receipt = within(dialog).getByRole('link', { name: 'View' });
        expect(receipt.getAttribute('href')).toBe(
            `https://explorer.solana.com/tx/${base58(wallet.signature)}?cluster=devnet`,
        );

        click('Done');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(button().getAttribute('data-mesub-state')).toBe('subscribed');
        expect((button() as HTMLButtonElement).disabled).toBe(true);
        expect(document.querySelector('[data-mesub-receipt]')?.textContent).toMatch(
            /^Next charge /,
        );
    });

    it("signs for the provider's chain", async () => {
        const { wallet } = setup({ chain: 'solana:mainnet' });

        await toReview();
        sign();
        await screen.findByRole('heading', { name: 'You are subscribed' });

        expect(wallet.signTransaction.mock.calls[0]![0]!.chain).toBe('solana:mainnet');
        expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).not.toContain(
            'cluster',
        );
    });

    it('shows no receipt link when the wallet is not the first signer', async () => {
        const { wallet } = setup();
        // Mesub pays the fee: its slot comes first, and is still empty.
        wallet.signTransaction.mockImplementationOnce(async () => [
            { signedTransaction: Uint8Array.from([2, ...new Uint8Array(64), ...TX_BYTES]) },
        ]);

        await toReview();
        sign();
        await screen.findByRole('heading', { name: 'You are subscribed' });

        expect(screen.queryByRole('link', { name: 'View' })).toBeNull();
    });

    it('follows the dialog on the button, and goes back to idle when it is closed', async () => {
        const { wallet } = setup();
        let release!: () => void;
        wallet.signMessage.mockImplementationOnce(
            () =>
                new Promise(
                    (resolve) =>
                        (release = () =>
                            resolve([
                                { signedMessage: new Uint8Array(), signature: wallet.signature },
                            ])),
                ),
        );

        expect(button().getAttribute('data-mesub-state')).toBe('idle');
        const dialog = await toReview();
        expect(button().getAttribute('data-mesub-state')).toBe('open');

        sign();
        await within(dialog).findByRole('heading', { name: 'Sign the terms in Fake Wallet' });
        expect(dialog.getAttribute('data-mesub-step')).toBe('approve');
        const under = document.querySelector('[data-mesub-subscribe]')!;
        expect(under.getAttribute('data-mesub-state')).toBe('signing');
        expect(under.getAttribute('aria-busy')).toBe('true');

        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(button().getAttribute('data-mesub-state')).toBe('idle');

        // The wallet answers once the dialog is gone: nothing is signed further, nothing sent.
        await act(async () => release());
        expect(wallet.signTransaction).not.toHaveBeenCalled();
    });
});

describe('the wallet', () => {
    it('offers Phantom and Solflare when none is installed', async () => {
        const { fetch } = setup({ wallet: false });

        const dialog = await toWallets();

        expect(
            within(dialog).getByRole('heading', { name: 'No Solana wallet found' }),
        ).toBeTruthy();
        expect(
            within(dialog)
                .getByRole('link', { name: /Phantom/ })
                .getAttribute('href'),
        ).toBe('https://phantom.com');
        expect(within(dialog).getByRole('button', { name: 'Reload' })).toBeTruthy();
        expect(made(fetch)).toEqual(['GET /plans/pro']);
    });

    it.each([
        ['solana:signMessage', 'Old Wallet cannot sign a message.'],
        ['solana:signTransaction', 'Old Wallet cannot sign a transaction without sending it.'],
    ])(
        'says what a wallet without %s cannot do, and offers nothing to sign',
        async (feature, said) => {
            const { fetch, wallet } = setup({ wallet: { name: 'Old Wallet', without: [feature] } });

            const dialog = await toWallets();

            expect(
                within(dialog).getByRole('heading', { name: 'This wallet cannot do it' }),
            ).toBeTruthy();
            expect(within(dialog).getByRole('alert').textContent).toBe(said);
            expect(within(dialog).queryByRole('button', { name: 'Old Wallet' })).toBeNull();
            expect(wallet.connect).not.toHaveBeenCalled();
            expect(made(fetch)).toEqual(['GET /plans/pro']);
        },
    );

    it('lists the wallets that can, and names the one that cannot', async () => {
        setup({ wallet: { name: 'Old Wallet', without: ['solana:signTransaction'] } });
        registerWallet({ name: 'Good Wallet' });

        const dialog = await toWallets();

        expect(await within(dialog).findByRole('button', { name: 'Good Wallet' })).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: 'Old Wallet' })).toBeNull();
        expect(within(dialog).getByRole('note').textContent).toBe(
            'Old Wallet cannot sign a transaction without sending it.',
        );
    });

    it('leaves out a wallet that is not on Solana', async () => {
        setup({ wallet: { name: 'Eth Wallet', chains: ['eip155:1'] } });

        const dialog = await toWallets();

        expect(
            within(dialog).getByRole('heading', { name: 'No Solana wallet found' }),
        ).toBeTruthy();
    });

    it('shows the refusal to connect, and prepares nothing', async () => {
        const { fetch, wallet } = setup();
        wallet.connect.mockRejectedValueOnce(new Error('User rejected the request.'));

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(
            await within(dialog).findByRole('heading', { name: 'Request rejected' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Fake Wallet said: User rejected the request.',
        );
        expect(made(fetch)).toEqual(['GET /plans/pro']);

        // Try again asks the same wallet, and carries on.
        click('Try again');
        await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' });
        expect(wallet.connect).toHaveBeenCalledTimes(2);
    });

    it('says so when the wallet shares no Solana account', async () => {
        const { wallet } = setup();
        wallet.connect.mockResolvedValueOnce({ accounts: [] });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'Fake Wallet shared no Solana account.',
        );
    });

    it('marks the wallet used last', async () => {
        setup();
        registerWallet({ name: 'Second Wallet' });

        let dialog = await toReview('Second Wallet');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        dialog = await toWallets();
        const row = await within(dialog).findByRole('button', { name: /Second Wallet/ });
        expect(within(row).getByText('Last used')).toBeTruthy();
    });

    it('never disconnects the wallet, whatever happens', async () => {
        const { wallet } = setup();
        wallet.signMessage.mockRejectedValueOnce(new Error('no'));

        const dialog = await toReview();
        sign();
        await within(dialog).findByRole('heading', { name: 'Terms not signed' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

        expect(wallet.disconnect).not.toHaveBeenCalled();
    });
});

describe('the two signatures', () => {
    it('stops when the wallet refuses the terms: nothing charged, nothing submitted', async () => {
        const { fetch, wallet, onSubscribed } = setup();
        wallet.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByRole('heading', { name: 'Terms not signed' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Fake Wallet said: User rejected the request.',
        );
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).toEqual(['GET /plans/pro', 'POST /subscriptions']);
        expect(onSubscribed).not.toHaveBeenCalled();

        // Try again asks the server anew, and shows what it costs again before signing.
        click('Try again');
        await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' });
        expect(bodies(fetch, 'POST /subscriptions')).toHaveLength(2);
        sign();
        expect(
            await within(dialog).findByRole('heading', { name: 'You are subscribed' }),
        ).toBeTruthy();
    });

    it('stops when the wallet refuses the transaction, after the terms', async () => {
        const { fetch, wallet } = setup();
        wallet.signTransaction.mockRejectedValueOnce(new Error('Window closed.'));

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByRole('heading', { name: 'Transaction not signed' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Fake Wallet said: Window closed.',
        );
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/submit');
    });

    it('stops when the wallet answers nothing', async () => {
        const { fetch, wallet } = setup();
        wallet.signTransaction.mockResolvedValueOnce([]);

        const dialog = await toReview();
        sign();

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'Fake Wallet returned no transaction.',
        );
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/submit');
    });

    it('asks the server again rather than sign terms that expired', async () => {
        let asked = 0;
        const { fetch, wallet } = setup({
            overrides: {
                // The first terms are already past their life when the review is read.
                'POST /subscriptions': () => json(201, prepared(asked++ === 0 ? -1000 : 600_000)),
            },
        });

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByText(
                'The terms had expired. These are fresh: check them again.',
            ),
        ).toBeTruthy();
        expect(wallet.signMessage).not.toHaveBeenCalled();
        expect(bodies(fetch, 'POST /subscriptions')).toEqual([
            { plan: 'pro', wallet: WALLET },
            { plan: 'pro', wallet: WALLET },
        ]);

        sign();
        expect(
            await within(dialog).findByRole('heading', { name: 'You are subscribed' }),
        ).toBeTruthy();
        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    });

    it('asks again when the terms expire while the wallet shows them', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { fetch, wallet } = setup({
            overrides: { 'POST /subscriptions': () => json(201, prepared(60_000)) },
        });
        wallet.signMessage.mockImplementationOnce(async () => {
            // The subscriber took two minutes to approve.
            vi.setSystemTime(Date.now() + 120_000);
            return [{ signedMessage: new Uint8Array(), signature: wallet.signature }];
        });

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByText(
                'The terms had expired. These are fresh: check them again.',
            ),
        ).toBeTruthy();
        // Stale terms never reach the transaction, nor the server.
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).not.toContain('POST /subscriptions/sub_1/submit');
        expect(bodies(fetch, 'POST /subscriptions')).toHaveLength(2);
    });

    it('prepares and signs once on a double click', async () => {
        const { fetch, wallet } = setup();

        const dialog = await toWallets();
        const row = await within(dialog).findByRole('button', { name: 'Fake Wallet' });
        fireEvent.click(row);
        fireEvent.click(row);
        const pay = await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' });
        expect(bodies(fetch, 'POST /subscriptions')).toHaveLength(1);

        fireEvent.click(pay);
        fireEvent.click(pay);
        await within(dialog).findByRole('heading', { name: 'You are subscribed' });

        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
        expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
        expect(bodies(fetch, 'POST /subscriptions')).toHaveLength(1);
        expect(bodies(fetch, 'POST /subscriptions/sub_1/submit')).toHaveLength(1);
    });

    it('opens one checkout on a double click of the button', async () => {
        const { fetch } = setup();

        fireEvent.click(button());
        fireEvent.click(button());
        await screen.findByRole('button', { name: 'Continue with a wallet' });

        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(made(fetch)).toEqual(['GET /plans/pro']);
    });
});

describe("what the merchant's server answers", () => {
    it('says to sign in on the site on a 401, and offers nothing to sign', async () => {
        const { fetch, wallet } = setup({
            overrides: {
                'POST /subscriptions': () => refusal(401, 'unauthenticated', 'Sign in first.'),
            },
        });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(await within(dialog).findByRole('heading', { name: 'Sign in first' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'You are not signed in on this site. Sign in here first, then subscribe again.',
        );
        expect(within(dialog).queryByRole('button', { name: /Sign and pay|Try again/ })).toBeNull();
        expect(wallet.signMessage).not.toHaveBeenCalled();
        expect(wallet.signTransaction).not.toHaveBeenCalled();
        expect(made(fetch)).toEqual(['GET /plans/pro', 'POST /subscriptions']);

        fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[1]!);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it("shows Mesub's own words on a 409, written for a person", async () => {
        const { wallet } = setup({
            overrides: {
                'POST /subscriptions': () =>
                    refusal(409, 'already_subscribed', 'This wallet is already subscribed to Pro.'),
            },
        });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(
            await within(dialog).findByRole('heading', { name: 'Cannot subscribe' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'This wallet is already subscribed to Pro.',
        );
        expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(wallet.signMessage).not.toHaveBeenCalled();
    });

    it('asks for another wallet on a 403', async () => {
        setup({
            overrides: {
                'POST /subscriptions': () =>
                    refusal(403, 'wallet_mismatch', 'Connect the wallet you signed in with.'),
            },
        });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(await within(dialog).findByRole('heading', { name: 'Wrong wallet' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'Connect the wallet you signed in with.',
        );
        click('Use another wallet');
        expect(await within(dialog).findByRole('button', { name: /Fake Wallet/ })).toBeTruthy();
    });

    it('says how long to wait on a 429', async () => {
        setup({
            overrides: {
                'POST /subscriptions': () =>
                    refusal(429, 'rate_limited', 'Slow down.', { 'Retry-After': '30' }),
            },
        });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect((await within(dialog).findByRole('alert')).textContent).toBe(
            'Try again in 30 seconds.',
        );
    });

    it('closes on a plan that does not exist', async () => {
        const { fetch } = setup({
            overrides: { 'GET /plans/pro': () => refusal(404, 'plan_not_found', 'No such plan.') },
        });

        fireEvent.click(button());
        const dialog = await screen.findByRole('dialog');

        expect(await within(dialog).findByRole('heading', { name: 'Plan not found' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe('No such plan.');
        expect(within(dialog).queryByRole('button', { name: 'Continue with a wallet' })).toBeNull();
        expect(made(fetch)).toEqual(['GET /plans/pro']);
    });

    it('offers no wallet for a plan that takes no new subscribers', async () => {
        setup({ overrides: { 'GET /plans/pro': () => json(200, { ...plan, available: false }) } });

        fireEvent.click(button());
        const dialog = await screen.findByRole('dialog');

        expect(await within(dialog).findByRole('heading', { name: 'Plan closed' })).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: 'Continue with a wallet' })).toBeNull();
    });

    it('reads the plan again after a network failure', async () => {
        let failed = false;
        const { fetch } = setup({
            overrides: {
                'GET /plans/pro': () => {
                    if (failed) return json(200, plan);
                    failed = true;
                    throw new TypeError('Failed to fetch');
                },
            },
        });

        fireEvent.click(button());
        const dialog = await screen.findByRole('dialog');

        expect(await within(dialog).findByRole('heading', { name: 'No answer' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe('Could not reach the server.');
        click('Try again');
        expect(await within(dialog).findByRole('heading', { name: 'Pro' })).toBeTruthy();
        expect(made(fetch)).toEqual(['GET /plans/pro', 'GET /plans/pro']);
    });

    it('offers to try again when preparing fails on the network', async () => {
        let failed = false;
        const { wallet } = setup({
            overrides: {
                'POST /subscriptions': () => {
                    if (failed) return json(201, prepared());
                    failed = true;
                    throw new TypeError('Failed to fetch');
                },
            },
        });

        const dialog = await toWallets();
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));

        expect(await within(dialog).findByRole('heading', { name: 'No answer' })).toBeTruthy();
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        click('Try again');
        expect(
            await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' }),
        ).toBeTruthy();
        // The wallet is not asked to connect again.
        expect(wallet.connect).toHaveBeenCalledTimes(1);
    });

    it('gives up on preparing after 15 seconds', async () => {
        setup({ overrides: { 'POST /subscriptions': never } });

        const dialog = await toWallets();
        const row = await within(dialog).findByRole('button', { name: 'Fake Wallet' });
        vi.useFakeTimers();
        fireEvent.click(row);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        vi.useRealTimers();

        expect(await within(dialog).findByRole('heading', { name: 'No answer' })).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe('No answer within 15 seconds.');
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
    });
});

describe('submit', () => {
    it('says nothing landed when Mesub gives a reason, and nothing was charged', async () => {
        const { onSubscribed } = setup({
            overrides: {
                'POST /subscriptions/sub_1/submit': () =>
                    json(201, {
                        subscription: subscription({ status: 'pending', access: false }),
                        reason: 'The wallet lacks 2 USDC to pay the first period.',
                    }),
            },
        });

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByRole('heading', { name: 'Payment did not go through' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'The wallet lacks 2 USDC to pay the first period.',
        );
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        expect(onSubscribed).not.toHaveBeenCalled();
        expect(
            document.querySelector('[data-mesub-subscribe]')!.getAttribute('data-mesub-state'),
        ).toBe('open');
    });

    it("shows Mesub's refusal of what was signed", async () => {
        setup({
            overrides: {
                'POST /subscriptions/sub_1/submit': () =>
                    refusal(409, 'transaction_expired', 'That transaction expired. Start again.'),
            },
        });

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByRole('heading', { name: 'Could not subscribe' }),
        ).toBeTruthy();
        expect(within(dialog).getByRole('alert').textContent).toBe(
            'That transaction expired. Start again.',
        );
        expect(within(dialog).getByText('Nothing was charged.')).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
    });

    it('waits 90 seconds for the chain, then offers to check again without signing twice', async () => {
        let hang = true;
        const { fetch, wallet, onSubscribed } = setup({
            overrides: {
                'POST /subscriptions/sub_1/submit': () =>
                    hang ? never() : json(201, { subscription: subscription() }),
            },
        });

        const dialog = await toReview();
        vi.useFakeTimers();
        sign();
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
        expect(within(dialog).getByText('Payment may be pending.')).toBeTruthy();
        expect(within(dialog).queryByText('Nothing was charged.')).toBeNull();
        // No way back to a second payment while this one may land.
        expect(within(dialog).queryByRole('button', { name: /Back|Try again/ })).toBeNull();

        hang = false;
        click('Check again');
        expect(
            await within(dialog).findByRole('heading', { name: 'You are subscribed' }),
        ).toBeTruthy();

        // The very same body, sent again: Mesub answers from what it already co-signed.
        const sent = bodies(fetch, 'POST /subscriptions/sub_1/submit');
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
        expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
        expect(onSubscribed).toHaveBeenCalledTimes(1);
    });

    it('treats a 502 as unknown: the payment may be pending', async () => {
        setup({
            overrides: {
                'POST /subscriptions/sub_1/submit': () =>
                    refusal(502, 'unavailable', 'Mesub did not answer.'),
            },
        });

        const dialog = await toReview();
        sign();

        expect(
            await within(dialog).findByRole('heading', { name: 'Still confirming' }),
        ).toBeTruthy();
        expect(within(dialog).getByText('Payment may be pending.')).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Check again' })).toBeTruthy();
    });

    it('still tells the merchant when the dialog was closed while confirming', async () => {
        let answer!: (response: Response) => void;
        const { onSubscribed } = setup({
            overrides: {
                'POST /subscriptions/sub_1/submit': () =>
                    new Promise<Response>((resolve) => (answer = resolve)),
            },
        });

        const dialog = await toReview();
        sign();
        await within(dialog).findByRole('heading', { name: 'Confirming on Solana' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await act(async () => answer(json(201, { subscription: subscription() })));
        await waitFor(() => expect(onSubscribed).toHaveBeenCalledWith(subscription()));
        // The button under it follows, though its dialog is gone.
        await waitFor(() => expect(button().getAttribute('data-mesub-state')).toBe('subscribed'));
    });
});

describe('useSubscribe, for a button of your own', () => {
    function Own() {
        const { state, subscription: held, subscribe } = useSubscribe('pro');
        const [answer, setAnswer] = useState<string>('none');
        return (
            <>
                <button
                    type="button"
                    onClick={() =>
                        void subscribe().then((result) => setAnswer(result ? result.id : 'null'))
                    }
                >
                    Buy
                </button>
                <output>
                    {state}:{held?.id ?? '-'}:{answer}
                </output>
            </>
        );
    }

    function own(overrides: Record<string, Handler> = {}) {
        const fetch = server({ ...routes, ...overrides });
        const wallet = registerWallet();
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={fetch}>
                <Own />
            </MesubProvider>,
        );
        return { fetch, wallet };
    }

    it('resolves with the subscription once the dialog is closed', async () => {
        own();

        click('Buy');
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(
            await within(dialog).findByRole('button', { name: 'Continue with a wallet' }),
        );
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Sign and pay 2 USDC' }));
        await within(dialog).findByRole('heading', { name: 'You are subscribed' });
        expect(screen.getByRole('status').textContent).toBe('subscribed:sub_1:none');

        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toBe('subscribed:sub_1:sub_1'),
        );
    });

    it('resolves with null when the dialog is closed before the end', async () => {
        own();

        click('Buy');
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByRole('button', { name: 'Continue with a wallet' });
        expect(screen.getByRole('status').textContent).toBe('open:-:none');
        fireEvent.keyDown(dialog, { key: 'Escape' });

        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('idle:-:null'));
    });

    it('throws outside the provider', () => {
        const silenced = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => render(<Own />)).toThrow('@mesub/react must be used inside <MesubProvider>');
        silenced.mockRestore();
    });
});

describe('the button', () => {
    it('takes a label, button props and a ref, and an onClick that can stop it', async () => {
        const fetch = server(routes);
        const ref = { current: null as HTMLButtonElement | null };
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={fetch} theme="dark">
                <SubscribeButton
                    plan="pro"
                    ref={ref}
                    className="mine"
                    onClick={(event) => event.preventDefault()}
                >
                    Go Pro
                </SubscribeButton>
            </MesubProvider>,
        );

        const own = screen.getByRole('button', { name: 'Go Pro' });
        expect(ref.current).toBe(own);
        expect(own.className).toBe('mine');
        expect(own.getAttribute('type')).toBe('button');
        expect(own.getAttribute('data-mesub-theme')).toBe('dark');

        fireEvent.click(own);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('puts the theme on the dialog', async () => {
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={server(routes)} theme="dark">
                <SubscribeButton plan="pro" />
            </MesubProvider>,
        );

        fireEvent.click(button());
        expect((await screen.findByRole('dialog')).getAttribute('data-mesub-theme')).toBe('dark');
    });
});
