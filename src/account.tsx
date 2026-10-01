import type { UiWallet } from '@wallet-standard/react';
import { useId, useRef, useState } from 'react';
import { useMesub } from './context';
import { MesubClientError } from './errors';
import { shortAddress } from './format';
import type { MesubWallet } from './wallets-api';

/** The installed wallet holding this address, for its icon. */
export function installedWith(wallets: readonly UiWallet[], address: string | null) {
    return wallets.find((wallet) => wallet.accounts.some((account) => account.address === address));
}

function nameOf(address: string, wallets: readonly MesubWallet[] | null): string {
    return wallets?.find((wallet) => wallet.address === address)?.label ?? shortAddress(address);
}

/** `Pro`, `Pro and Team`, `Pro, Team and Max`. */
function listOf(names: readonly string[]): string {
    if (names.length < 2) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function messageOf(error: unknown): string {
    return error instanceof MesubClientError ? error.message : 'Something went wrong. Try again.';
}

// What waits on the warning: leaving the current wallet, for a linked one or a new one.
type Leaving = { kind: 'select'; address: string } | { kind: 'connect' };

/**
 * Signed in as, the wallet that pays here, and Change: the account's wallets,
 * to switch between without signing, or another one to connect.
 */
export function Account({
    email,
    address,
    installed,
    onConnect,
    onSwitched,
}: {
    email: string;
    address: string;
    installed: readonly UiWallet[];
    onConnect(): void;
    onSwitched(): void;
}) {
    const { wallets, loadWallets, selectWallet } = useMesub();
    const menuId = useId();
    const change = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [leaving, setLeaving] = useState<Leaving | null>(null);
    const [error, setError] = useState('');

    const current = wallets?.find((wallet) => wallet.address === address);
    const held = current?.plans ?? [];
    // The list could not be read: the plans held are unknown, so warn anyway.
    const unknown = wallets === null;
    const icon = installedWith(installed, address)?.icon;

    // After a refused switch, the refusal stays up while the list is read again.
    function load(clear = true) {
        setLoading(true);
        if (clear) setError('');
        loadWallets()
            .catch((failure: unknown) => setError(messageOf(failure)))
            .finally(() => setLoading(false));
    }

    function close() {
        setOpen(false);
        setLeaving(null);
        setError('');
        change.current?.focus();
    }

    function toggle() {
        if (open) {
            close();
            return;
        }
        setOpen(true);
        // Read each time it opens: a plan may have been taken since.
        load();
    }

    async function select(next: string) {
        setLeaving(null);
        setError('');
        setBusy(next);
        try {
            await selectWallet(next);
            onSwitched();
            close();
        } catch (failure) {
            setError(messageOf(failure));
            // Not one of the account's wallets any more: show the list as it is.
            if (failure instanceof MesubClientError && failure.status === 404) load(false);
        } finally {
            setBusy(null);
        }
    }

    function leave(next: Leaving) {
        if (held.length > 0 || unknown) {
            setLeaving(next);
            return;
        }
        if (next.kind === 'connect') onConnect();
        else void select(next.address);
    }

    function confirm() {
        if (!leaving) return;
        if (leaving.kind === 'connect') onConnect();
        else void select(leaving.address);
    }

    const plural = held.length > 1 ? 'subscriptions' : 'subscription';
    return (
        <>
            <div data-mesub-account="">
                <p>
                    Signed in as <strong>{email}</strong>
                </p>
                <span data-mesub-account-wallet="" title={address}>
                    {icon ? <img src={icon} alt="" width={16} height={16} /> : null}
                    {nameOf(address, wallets)}
                </span>
                <button
                    ref={change}
                    type="button"
                    data-mesub-change=""
                    aria-expanded={open}
                    aria-controls={open ? menuId : undefined}
                    onClick={toggle}
                >
                    Change
                </button>
            </div>
            {open ? (
                <div data-mesub-wallet-menu="" id={menuId}>
                    {wallets ? (
                        <ul data-mesub-linked-wallets="" aria-label="Your wallets">
                            {wallets.map((wallet) => {
                                const selected = wallet.address === address;
                                const walletIcon = installedWith(installed, wallet.address)?.icon;
                                return (
                                    <li key={wallet.address}>
                                        <button
                                            type="button"
                                            data-mesub-linked=""
                                            title={wallet.address}
                                            aria-current={selected || undefined}
                                            aria-busy={busy === wallet.address || undefined}
                                            disabled={busy !== null}
                                            onClick={() =>
                                                selected
                                                    ? close()
                                                    : leave({
                                                          kind: 'select',
                                                          address: wallet.address,
                                                      })
                                            }
                                        >
                                            {walletIcon ? (
                                                <img
                                                    src={walletIcon}
                                                    alt=""
                                                    width={24}
                                                    height={24}
                                                />
                                            ) : null}
                                            <span>
                                                {wallet.label ?? shortAddress(wallet.address)}
                                                {wallet.plans.length > 0 ? (
                                                    <small>{wallet.plans.join(', ')}</small>
                                                ) : null}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : loading ? (
                        <p data-mesub-notice="" role="status" aria-busy="true">
                            Loading your wallets
                        </p>
                    ) : null}
                    {leaving ? (
                        <div data-mesub-leaving="">
                            <p data-mesub-warning="" role="alert">
                                {held.length > 0
                                    ? `Your ${listOf(held)} ${plural} will not be recognised on this site with the new wallet.`
                                    : 'Any subscription this wallet pays for here will not be recognised on this site with the new wallet.'}
                            </p>
                            <button type="button" data-mesub-confirm="" onClick={confirm}>
                                Switch anyway
                            </button>
                            <button
                                type="button"
                                data-mesub-keep=""
                                onClick={() => setLeaving(null)}
                            >
                                Keep {nameOf(address, wallets)}
                            </button>
                        </div>
                    ) : null}
                    {error ? (
                        <p role="alert" data-mesub-error="">
                            {error}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        data-mesub-connect=""
                        disabled={busy !== null || loading}
                        onClick={() => leave({ kind: 'connect' })}
                    >
                        Connect another wallet
                    </button>
                </div>
            ) : null}
        </>
    );
}
