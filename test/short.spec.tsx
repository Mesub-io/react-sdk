import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ManageButton, ManageSubscriptions, MesubProvider, SubscribeButton } from '../src';
import { paidBrief } from '../src/detail-logic';
import { brief, briefPrice, fit, formatAmount, priceOf, short, termsFacts } from '../src/format';
import type { MesubPlan } from '../src/types';
import {
    checkout,
    ENDPOINT,
    json,
    plan as usdc,
    prepared,
    server,
    subscription,
    type Handler,
} from './helpers';
import { registerWallet } from './wallets';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const DECIMALS = 5;

/** A verified coin charged `display` every hour. */
const bonk = (display: string): MesubPlan => ({
    ...usdc,
    period_hours: 1,
    network: 'mainnet-beta',
    amount: `${display}${'0'.repeat(DECIMALS)}`,
    amount_display: display,
    decimals: DECIMALS,
    symbol: null,
    mint: MINT,
    token: { symbol: 'Bonk', name: 'Bonk', logo_url: 'https://img.test/bonk.png', verified: true },
    amount_usd: '0.1',
});
/** The same amount of a mint an older server does not name. */
const unnamed = (display: string): MesubPlan => ({ ...bonk(display), token: undefined });
/** 1,500 USDC: vouched, so never shortened. */
const stable = (display: string): MesubPlan => ({
    ...usdc,
    period_hours: 1,
    network: 'mainnet-beta',
    amount: `${display}000000`,
    amount_display: display,
});

const terms = (amount: string, token: string) =>
    [
        'Mesub: the terms of the subscription you are about to sign.',
        `Amount: ${amount} every hour`,
        `First charge: ${amount} now, in the transaction you sign next`,
        `Then: ${amount} every hour, until you cancel`,
        'Subscription: Pro, from Fraise',
        `Token: ${token}`,
        'Nonce: 42',
    ].join('\n');
const messageOf = (plan: MesubPlan) =>
    plan.symbol
        ? terms(`${plan.amount_display} ${plan.symbol}`, `${plan.symbol}, mint ${plan.mint}`)
        : terms(`${plan.amount_display} tokens`, `mint ${plan.mint}`);

const rows = (list: Element) =>
    [...list.querySelectorAll('[data-mesub-row]')].map((each) => [
        each.querySelector('dt')?.textContent,
        each.querySelector('dd')?.textContent,
    ]);
const row = (within_: Element, label: string) =>
    [...within_.querySelectorAll('[data-mesub-row]')]
        .find((each) => each.querySelector('dt')?.textContent === label)
        ?.querySelector('dd') ?? null;
const title = (element: Element | null | undefined) => element?.getAttribute('title') ?? null;

describe('short', () => {
    it.each([
        // The issue's own examples.
        ['30000', '30K'],
        ['30500', '30.5K'],
        ['1500000', '1.5M'],
        ['6000000000', '6B'],
        ['30512', null],
        ['1234000', null],
        // Where it starts, and what is lost just past it.
        ['9999', null],
        ['10000', '10K'],
        ['10001', null],
        ['10010', '10.01K'],
        ['10100', '10.1K'],
        ['999990', '999.99K'],
        ['999999', null],
        ['1000000', '1M'],
        ['1230000', '1.23M'],
        ['999990000', '999.99M'],
        ['1000000000', '1B'],
        ['1000000000000', '1T'],
        ['1500000000000', '1.5T'],
        ['999990000000000', '999.99T'],
        // From 1e15 up: full digits.
        ['1000000000000000', null],
        ['12345678901234567890', null],
        ['10000000000000000000', null],
        // Under 10,000.
        ['0', null],
        ['1', null],
        ['1500', null],
        // A fraction stays whole.
        ['30000.5', null],
        ['30000.0', null],
        ['0.5', null],
        // Leading zeros are not digits of the amount.
        ['0030000', '30K'],
        ['00009999', null],
        ['0000', null],
        // Not an amount.
        ['', null],
        ['abc', null],
        ['-30000', null],
        ['3e4', null],
        ['30,000', null],
        [' 30000', null],
        ['30000 ', null],
    ])('%s is %s', (display, expected) => {
        expect(short(display)).toBe(expected);
    });

    it('never goes through a float', () => {
        // 2^53 + 1 and its neighbours: a float would round them together.
        expect(short('9007199254740993')).toBeNull();
        expect(short('900719925474099')).toBeNull();
        expect(short('900710000000000')).toBe('900.71T');
        expect(short('900710000000001')).toBeNull();
    });
});

describe('short or full, for a plan', () => {
    it('shortens a token that is not a vouched stablecoin, with the exact amount as title', () => {
        expect(briefPrice(bonk('30000'))).toEqual({ text: '30K Bonk', title: '30,000 Bonk' });
        expect(briefPrice(bonk('6000000000'))).toEqual({
            text: '6B Bonk',
            title: '6,000,000,000 Bonk',
        });
        expect(briefPrice(bonk('30512'))).toEqual({ text: '30,512 Bonk', title: undefined });
        expect(briefPrice(bonk('30000.5'))).toEqual({ text: '30,000.5 Bonk', title: undefined });
    });

    it('shortens an unnamed mint too: nobody vouches for it', () => {
        expect(briefPrice(unnamed('30000'))).toEqual({
            text: '30K DezX…B263',
            title: '30,000 DezX…B263',
        });
        expect(briefPrice({ ...unnamed('30000'), token: null })).toEqual({
            text: '30K DezX…B263',
            title: '30,000 DezX…B263',
        });
    });

    it('never shortens a vouched stablecoin', () => {
        expect(briefPrice(stable('1500'))).toEqual({ text: '1,500 USDC', title: undefined });
        expect(briefPrice(stable('30000'))).toEqual({ text: '30,000 USDC', title: undefined });
        expect(briefPrice(stable('6000000000'))).toEqual({
            text: '6,000,000,000 USDC',
            title: undefined,
        });
    });

    it('returns what is not a number untouched', () => {
        expect(brief('n/a', false)).toEqual({ text: 'n/a', title: undefined });
        expect(brief('', false, ' Bonk')).toEqual({ text: ' Bonk', title: undefined });
    });

    it('keeps the exact price where it is asked for', () => {
        expect(priceOf(bonk('30000'))).toBe('30,000 Bonk');
        expect(priceOf(bonk('6000000000'))).toBe('6,000,000,000 Bonk');
    });

    it('shortens a total counted from base units', () => {
        expect(paidBrief('9000000000', bonk('30000'), formatAmount)).toEqual({
            text: '90K Bonk',
            title: '90,000 Bonk',
        });
        expect(paidBrief('9153600000', bonk('30512'), formatAmount)).toEqual({
            text: '91,536 Bonk',
            title: undefined,
        });
        // A fraction stays whole.
        expect(paidBrief('9000000001', bonk('30000'), formatAmount)).toEqual({
            text: '90,000.00001 Bonk',
            title: undefined,
        });
        expect(paidBrief('9000000000', unnamed('30000'), formatAmount)).toEqual({
            text: '90K',
            title: '90,000',
        });
        expect(paidBrief('90000000000', stable('30000'), formatAmount)).toEqual({
            text: '90,000 USDC',
            title: undefined,
        });
        expect(paidBrief('abc', bonk('30000'), formatAmount)).toBeNull();
        expect(paidBrief('9000000000', undefined, formatAmount)).toBeNull();
    });

    it('marks only a long amount to shrink', () => {
        expect(fit('30K Bonk')).toBeUndefined();
        expect(fit('1,500 USDC')).toBeUndefined();
        expect(fit('30,512 Bonk')).toBeUndefined();
        expect(fit('30K DezX…B263')).toBeUndefined();
        expect(fit('123,456,789 Bonk')).toBe('2');
        expect(fit('123,456,789,012 Bonk')).toBe('3');
        expect(fit('1,234,567,890,123,456,789 Bonk')).toBe('3');
        expect(fit('1,234,567,890,123,456,789 DezX…B263')).toBe('4');
    });

    it('leaves the terms summary exact', () => {
        const plan = bonk('6000000000');
        const facts = Object.fromEntries(
            termsFacts(messageOf(plan), plan).map((each) => [each.label, each.value]),
        );

        expect(facts['First charge']).toBe('6,000,000,000 Bonk now');
        expect(facts['Then']).toBe('6,000,000,000 Bonk every hour, until you cancel');
    });
});

describe('the checkout', () => {
    function mount(plan: MesubPlan) {
        const answer = { ...prepared(), terms: { ...prepared().terms, message: messageOf(plan) } };
        const fetch = server(
            checkout({
                'GET /plans/pro': () => json(200, plan),
                'POST /subscriptions': () => json(201, answer),
                'POST /subscriptions/sub_1/submit': () =>
                    json(201, { subscription: subscription() }),
            }),
        );
        const wallet = registerWallet({});
        render(
            <MesubProvider endpoint={ENDPOINT} chain="solana:mainnet" fetch={fetch}>
                <SubscribeButton plan="pro" />
            </MesubProvider>,
        );
        return wallet;
    }

    async function toPlan() {
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByRole('button', { name: 'Continue with a wallet' });
        return dialog;
    }

    async function toReview(dialog: HTMLElement) {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with a wallet' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));
        return within(dialog).findByRole('button', { name: /^Sign and pay / });
    }

    const price = (dialog: HTMLElement) => dialog.querySelector('[data-mesub-price] strong');

    it.each([
        // display, as read fast, exact
        ['30000', '30K Bonk', '30,000 Bonk'],
        ['30512', '30,512 Bonk', null],
        ['6000000000', '6B Bonk', '6,000,000,000 Bonk'],
    ])('a verified coin of %s reads %s on every screen', async (display, shown, exact) => {
        const wallet = mount(bonk(display));
        // Held at the second approval, to read its sentence.
        let approve = () => {};
        const signed = wallet.signTransaction.getMockImplementation()!;
        wallet.signTransaction.mockImplementationOnce(
            (...inputs) =>
                new Promise((resolve) => {
                    approve = () => resolve(signed(...inputs));
                }),
        );
        const full = exact ?? shown;

        const dialog = await toPlan();
        expect(price(dialog)?.textContent).toBe(shown);
        expect(title(price(dialog))).toBe(exact);
        expect(price(dialog)?.hasAttribute('data-mesub-fit')).toBe(false);

        const submit = await toReview(dialog);
        expect(price(dialog)?.textContent).toBe(shown);
        expect(title(price(dialog))).toBe(exact);
        expect(submit.textContent).toBe(`Sign and pay ${shown}`);
        expect(title(submit)).toBe(exact);
        // Where one commits: the exact amount, grouped.
        expect(rows(dialog.querySelector('[data-mesub-terms]')!)).toEqual([
            ['First charge', `${full} now`],
            ['Then', `${full} every hour, until you cancel`],
            ['Subscription', 'Pro, from Fraise'],
            ['Token', 'Bonk, mint DezX…B263'],
        ]);

        fireEvent.click(submit);
        const step = await within(dialog).findByText(/^Step 2 of 2/);
        expect(step.textContent).toBe(`Step 2 of 2: ${shown} now, then ${shown} every hour.`);
        expect(title(step)).toBe(exact);

        approve();
        await within(dialog).findByRole('heading', { name: 'You are subscribed' });
        const line = within(dialog).getByText(`Pro, ${shown} every hour`);
        expect(title(line)).toBe(exact);
        expect(row(dialog, 'Paid today')?.textContent).toBe(`${shown}about $0.10`);
        expect(title(row(dialog, 'Paid today'))).toBe(exact);
        // What is signed is the server's message, to the letter.
        expect(wallet.signMessage.mock.calls[0]![0]).toEqual({
            account: wallet.account,
            message: new TextEncoder().encode(messageOf(bonk(display))),
        });
    });

    it('a stablecoin of 1,500: nothing changes, and no title', async () => {
        mount(stable('1500'));
        const dialog = await toPlan();

        expect(price(dialog)?.textContent).toBe('1,500 USDC');
        expect(title(price(dialog))).toBeNull();

        const submit = await toReview(dialog);
        expect(submit.textContent).toBe('Sign and pay 1,500 USDC');
        expect(title(submit)).toBeNull();
        expect(submit.hasAttribute('data-mesub-fit')).toBe(false);
        expect(rows(dialog.querySelector('[data-mesub-terms]')!).slice(0, 2)).toEqual([
            ['First charge', '1,500 USDC now'],
            ['Then', '1,500 USDC every hour, until you cancel'],
        ]);

        fireEvent.click(submit);
        await within(dialog).findByRole('heading', { name: 'You are subscribed' });
        expect(within(dialog).getByText('Pro, 1,500 USDC every hour')).toBeTruthy();
        expect(row(dialog, 'Paid today')?.textContent).toBe('1,500 USDC');
        expect(title(row(dialog, 'Paid today'))).toBeNull();
    });

    it('a stablecoin of 30,000 stays in full', async () => {
        mount(stable('30000'));
        const dialog = await toPlan();

        expect(price(dialog)?.textContent).toBe('30,000 USDC');
        expect((await toReview(dialog)).textContent).toBe('Sign and pay 30,000 USDC');
    });

    it('an unnamed mint follows the same rule', async () => {
        mount(unnamed('30000'));
        const dialog = await toPlan();

        expect(price(dialog)?.textContent).toBe('30K DezX…B263');
        expect(title(price(dialog))).toBe('30,000 DezX…B263');

        const submit = await toReview(dialog);
        expect(submit.textContent).toBe('Sign and pay 30K DezX…B263');
        expect(rows(dialog.querySelector('[data-mesub-terms]')!).slice(0, 2)).toEqual([
            ['First charge', '30,000 tokens now'],
            ['Then', '30,000 tokens every hour, until you cancel'],
        ]);
    });

    it.each([
        ['123456789012', '123,456,789,012 Bonk', '3'],
        ['1234567890123456789', '1,234,567,890,123,456,789 Bonk', '3'],
    ])('an amount in full digits (%s) is marked to shrink', async (display, shown, level) => {
        mount(bonk(display));
        const dialog = await toPlan();

        expect(price(dialog)?.textContent).toBe(shown);
        expect(price(dialog)?.getAttribute('data-mesub-fit')).toBe(level);
        expect(title(price(dialog))).toBeNull();

        const submit = await toReview(dialog);
        expect(submit.textContent).toBe(`Sign and pay ${shown}`);
        expect(submit.getAttribute('data-mesub-fit')).toBeTruthy();
        expect(price(dialog)?.getAttribute('data-mesub-fit')).toBe(level);
    });
});

describe('the subscriptions', () => {
    const SIGNATURE = '5'.repeat(64);

    function mount(plan: MesubPlan, Widget: 'list' | 'button' = 'button') {
        const handlers: Record<string, Handler> = {
            'GET /plans/pro': () => json(200, plan),
            'GET /subscriptions': () => json(200, { subscriptions: [subscription()] }),
            'GET /subscriptions/sub_1': () =>
                json(200, {
                    subscription: subscription(),
                    upcoming: [
                        {
                            kind: 'charge',
                            due_at: '2999-10-04T12:00:00.000Z',
                            amount: plan.amount,
                            amount_display: plan.amount_display,
                        },
                    ],
                    payments: [
                        {
                            attempted_at: '2026-10-01T12:00:00.000Z',
                            outcome: 'paid',
                            amount: plan.amount,
                            reason: null,
                            signature: SIGNATURE,
                        },
                        {
                            attempted_at: '2026-10-01T11:00:00.000Z',
                            outcome: 'rejected',
                            amount: plan.amount,
                            reason: null,
                            signature: null,
                        },
                    ],
                    // Three charges.
                    paid: { count: 3, amount: (BigInt(plan.amount) * 3n).toString() },
                }),
        };
        registerWallet({ connected: true });
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={server(handlers)}>
                {Widget === 'list' ? <ManageSubscriptions /> : <ManageButton plan="pro" />}
            </MesubProvider>,
        );
    }

    async function open() {
        fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(dialog.querySelector('[data-mesub-payment]')).toBeTruthy());
        return dialog;
    }

    async function listed() {
        await screen.findByRole('list', { name: 'Your subscriptions' });
        return waitFor(() => {
            const price = document.querySelector<HTMLElement>('[data-mesub-subscription-price]');
            expect(price).toBeTruthy();
            return price!;
        });
    }

    const payments = (dialog: HTMLElement) =>
        [...dialog.querySelectorAll('[data-mesub-payment] > span:last-child')].map(
            (each) => each.textContent,
        );

    it.each([
        // display, as read fast, exact, three charges as read fast, exact
        ['30000', '30K Bonk', '30,000 Bonk', '90K Bonk', '90,000 Bonk'],
        ['30512', '30,512 Bonk', null, '91,536 Bonk', null],
        ['6000000000', '6B Bonk', '6,000,000,000 Bonk', '18B Bonk', '18,000,000,000 Bonk'],
    ])(
        'a verified coin of %s reads %s, listed and opened',
        async (display, shown, exact, total, totalExact) => {
            const full = exact ?? shown;
            mount(bonk(display), 'list');
            const listedPrice = await listed();

            expect(listedPrice.textContent).toBe(`${shown} every hour`);
            expect(title(listedPrice.querySelector('strong'))).toBe(exact);
            document.body.innerHTML = '';

            mount(bonk(display));
            const dialog = await open();
            const rate = dialog.querySelector('[data-mesub-rate]')!;

            expect(rate.textContent).toBe(`${shown} every hour`);
            expect(title(rate.querySelector('strong'))).toBe(exact);
            expect(row(dialog, 'Total paid')?.textContent).toBe(total);
            expect(title(row(dialog, 'Total paid'))).toBe(totalExact);
            // Each payment, due or made: the exact amount.
            expect(payments(dialog)).toEqual([full, full, full]);
            expect(within(dialog).getByRole('link', { name: full })).toBeTruthy();
        },
    );

    it('a stablecoin of 1,500: nothing changes, and no title', async () => {
        mount(stable('1500'));
        const dialog = await open();
        const rate = dialog.querySelector('[data-mesub-rate]')!;

        expect(rate.textContent).toBe('1,500 USDC every hour');
        expect(title(rate.querySelector('strong'))).toBeNull();
        expect(row(dialog, 'Total paid')?.textContent).toBe('4,500 USDC');
        expect(title(row(dialog, 'Total paid'))).toBeNull();
        expect(payments(dialog)).toEqual(['1,500 USDC', '1,500 USDC', '1,500 USDC']);
    });

    it('lists a stablecoin of 30,000 in full', async () => {
        mount(stable('30000'), 'list');
        const price = await listed();

        expect(price.textContent).toBe('30,000 USDC every hour');
        expect(title(price.querySelector('strong'))).toBeNull();
    });

    it('an unnamed mint follows the same rule', async () => {
        mount(unnamed('30000'));
        const dialog = await open();

        expect(dialog.querySelector('[data-mesub-rate]')?.textContent).toBe(
            '30K DezX…B263 every hour',
        );
        expect(row(dialog, 'Total paid')?.textContent).toBe('90K');
        expect(title(row(dialog, 'Total paid'))).toBe('90,000');
        expect(payments(dialog)).toEqual(['30,000', '30,000', '30,000']);
    });

    it('marks an amount in full digits to shrink, in the rate and in each payment', async () => {
        mount(bonk('1234567890123456789'));
        const dialog = await open();
        const shown = '1,234,567,890,123,456,789 Bonk';

        expect(dialog.querySelector('[data-mesub-rate] strong')?.textContent).toBe(shown);
        expect(
            dialog.querySelector('[data-mesub-rate] strong')?.getAttribute('data-mesub-fit'),
        ).toBe('3');
        expect(payments(dialog)).toEqual([shown, shown, shown]);
        expect(
            dialog.querySelectorAll('[data-mesub-payment] > span:last-child[data-mesub-fit]'),
        ).toHaveLength(3);
    });
});
