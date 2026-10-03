import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApi, type FetchLike } from './api';
import { Checkout } from './checkout';
import {
    MesubContext,
    type ManageRequest,
    type MesubInternal,
    type MesubTheme,
    type SubscribeRequest,
} from './context';
import { Manage } from './manage';
import { SubscriptionDialog } from './detail';
import type { MesubPlan, MesubSubscription } from './types';
import type { SolanaChain } from './wallet';

export interface MesubProviderProps {
    // Where your server mounts the routes of @mesub/node: "/api/mesub".
    endpoint: string;
    // The network the wallet signs for and sends on. solana:devnet by default.
    chain?: SolanaChain | undefined;
    // To add your own headers or credentials. By default, credentials: 'include'.
    fetch?: FetchLike | undefined;
    // data-mesub-theme on the widget. Leave it out to inherit it from an ancestor.
    theme?: MesubTheme | undefined;
    // Where "Cancel any time" leads once subscribed: your own page ("/account"), Mesub's by
    // default, null for no button.
    manageUrl?: string | null | undefined;
    children?: ReactNode;
}

type Open =
    { kind: 'subscribe'; request: SubscribeRequest } | { kind: 'manage'; request: ManageRequest };

interface Pending {
    promise: Promise<MesubSubscription | null>;
    resolve(result: MesubSubscription | null): void;
    // What the dialog settled on, handed over when it closes.
    result: MesubSubscription | null;
}

/** Says where the merchant's routes are, and renders the one dialog the hooks open. */
export function MesubProvider({
    endpoint,
    chain = 'solana:devnet',
    fetch,
    theme,
    manageUrl,
    children,
}: MesubProviderProps) {
    const api = useMemo(() => createApi({ endpoint, fetch }), [endpoint, fetch]);
    const plans = useMemo(() => new Map<string, Promise<MesubPlan>>(), [api]);
    const [open, setOpen] = useState<Open | null>(null);
    const [revision, setRevision] = useState(0);
    const pending = useRef<Pending | null>(null);
    // The subscription's own window, up behind whatever its action opens.
    const [managed, setManaged] = useState<{ plan: string | undefined } | null>(null);
    const openSubscription = useCallback((plan: string | undefined) => setManaged({ plan }), []);

    // Unmounted with a dialog up: whoever waits on it is answered.
    useEffect(
        () => () => {
            pending.current?.resolve(null);
            pending.current = null;
        },
        [],
    );

    const plan = useCallback(
        (slug: string) => {
            let read = plans.get(slug);
            if (!read) {
                read = api.plan(slug);
                plans.set(slug, read);
                read.catch(() => plans.delete(slug));
            }
            return read;
        },
        [api, plans],
    );

    // One dialog at a time: a second click gets the first one's answer.
    const start = useCallback((next: Open) => {
        if (pending.current) return pending.current.promise;
        let resolve!: Pending['resolve'];
        const promise = new Promise<MesubSubscription | null>((done) => {
            resolve = done;
        });
        pending.current = { promise, resolve, result: null };
        setOpen(next);
        return promise;
    }, []);

    const subscribe = useCallback(
        (request: SubscribeRequest) => start({ kind: 'subscribe', request }),
        [start],
    );
    const manage = useCallback(
        (request: ManageRequest) => start({ kind: 'manage', request }),
        [start],
    );

    const settled = useCallback((subscription: MesubSubscription | null) => {
        if (pending.current && subscription) pending.current.result = subscription;
        setRevision((current) => current + 1);
    }, []);

    const close = useCallback(() => {
        pending.current?.resolve(pending.current.result);
        pending.current = null;
        setOpen(null);
    }, []);

    const value = useMemo<MesubInternal>(
        () => ({
            api,
            chain,
            theme,
            manageUrl,
            plan,
            revision,
            subscribe,
            manage,
            openSubscription,
        }),
        [api, chain, theme, manageUrl, plan, revision, subscribe, manage, openSubscription],
    );

    return (
        <MesubContext.Provider value={value}>
            {children}
            {open?.kind === 'subscribe' ? (
                <Checkout
                    plan={open.request.plan}
                    onState={open.request.onState}
                    onSubscribed={(subscription, signature) => {
                        settled(subscription);
                        open.request.onSubscribed(subscription, signature);
                    }}
                    onClose={close}
                />
            ) : null}
            {/* One native dialog at a time: it steps aside while its action runs. */}
            {managed && !open ? (
                <SubscriptionDialog plan={managed.plan} onClose={() => setManaged(null)} />
            ) : null}
            {open?.kind === 'manage' ? (
                <Manage
                    subscription={open.request.subscription}
                    action={open.request.action}
                    onChanged={settled}
                    onClose={close}
                />
            ) : null}
        </MesubContext.Provider>
    );
}
