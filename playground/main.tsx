import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MesubProvider, SubscribeButton, useMesub, type MesubSubscription } from '@mesub/react';

import './style.css';

const publishableKey = import.meta.env['VITE_MESUB_PUBLISHABLE_KEY'] ?? '';
const apiUrl = import.meta.env['VITE_MESUB_API_URL'] ?? 'http://localhost:3333';
// The local back runs on devnet.
const chain = (import.meta.env['VITE_MESUB_CHAIN'] ?? 'solana:devnet') as `solana:${string}`;

/** Everything `useMesub()` answers, and a button per action. Plain on purpose. */
function Session() {
    const { ready, user, wallet, login, logout, getAccessToken } = useMesub();
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState('');

    async function run(action: () => Promise<unknown>) {
        setError('');
        try {
            await action();
        } catch (caught) {
            setError(
                caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
            );
        }
    }

    const state = !ready ? 'wait' : user ? 'on' : 'off';

    return (
        <main>
            <header>
                <h1>@mesub/react playground</h1>
                <p>
                    <code>{apiUrl}</code> · <code>{publishableKey.slice(0, 12)}…</code>
                </p>
            </header>

            <section className="card">
                <h2>Session</h2>
                <dl className="rows">
                    <dt>state</dt>
                    <dd>
                        <span className={`pill ${state}`}>
                            {!ready ? 'loading' : user ? 'signed in' : 'signed out'}
                        </span>
                    </dd>
                    <dt>email</dt>
                    <dd>{user?.email ?? '-'}</dd>
                    <dt>wallet</dt>
                    <dd>
                        <code>{wallet ?? '-'}</code>
                    </dd>
                </dl>
            </section>

            <section className="card">
                <h2>Actions</h2>
                <div className="actions">
                    <button
                        type="button"
                        className="primary"
                        onClick={() => run(login)}
                        disabled={!ready || Boolean(user)}
                    >
                        Sign in
                    </button>
                    <button type="button" onClick={() => run(logout)} disabled={!user}>
                        Sign out
                    </button>
                    <button
                        type="button"
                        onClick={() => run(async () => setToken(await getAccessToken()))}
                    >
                        Get access token
                    </button>
                </div>
                <p className="hint" style={{ marginTop: 12 }}>
                    The code is mailed to Mailpit:{' '}
                    <a href="http://localhost:8025" target="_blank" rel="noreferrer">
                        localhost:8025
                    </a>
                </p>
            </section>

            <Subscribe />

            <CallServer />

            {error && (
                <p className="alert" role="alert">
                    {error}
                </p>
            )}

            {token !== null && (
                <section className="card">
                    <h2>Access token</h2>
                    <pre>{token || 'null'}</pre>
                </section>
            )}
        </main>
    );
}

/** A plan slug and the button, with what it settled on. */
function Subscribe() {
    const [plan, setPlan] = useState(import.meta.env['VITE_MESUB_PLAN'] ?? 'contract');
    const [subscribed, setSubscribed] = useState<MesubSubscription | null>(null);

    return (
        <section className="card">
            <h2>Subscribe</h2>
            <div className="actions">
                <label className="field">
                    plan slug
                    <input value={plan} onChange={(event) => setPlan(event.target.value.trim())} />
                </label>
                {/* Keyed on the slug: another plan starts from idle. */}
                <SubscribeButton
                    key={plan}
                    plan={plan}
                    chain={chain}
                    className="primary"
                    onSubscribed={setSubscribed}
                />
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
                Sends on <code>{chain}</code>. Signs in first when signed out.
            </p>
            {subscribed && <pre>{JSON.stringify(subscribed, null, 2)}</pre>}
        </section>
    );
}

const serverUrl = import.meta.env['VITE_PLAYGROUND_SERVER'] ?? 'http://localhost:5174';

/**
 * What the access token is for: the merchant's own server reads it and lets
 * the request through only for a subscriber of the plan (playground/server.mjs).
 */
function CallServer() {
    const { getAccessToken } = useMesub();
    const [answer, setAnswer] = useState<{ status: number; body: string } | null>(null);
    const [failure, setFailure] = useState('');

    async function call() {
        setFailure('');
        try {
            const token = await getAccessToken();
            const response = await fetch(`${serverUrl}/api/reports`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            const body = await response.text();
            let pretty = body;
            try {
                pretty = JSON.stringify(JSON.parse(body), null, 2);
            } catch {
                // Not JSON: shown as it came.
            }
            setAnswer({ status: response.status, body: pretty });
        } catch {
            setAnswer(null);
            setFailure(`No answer from ${serverUrl}: start it with pnpm playground:server.`);
        }
    }

    const meaning: Record<number, string> = {
        200: 'Let through: the token is valid and the wallet has access.',
        401: 'No valid token: sign in first.',
        402: 'Signed in, but no access to the plan: subscribe first.',
        503: 'Mesub could not be reached to check the token.',
    };

    return (
        <section className="card">
            <h2>Call my server</h2>
            <p className="hint">
                Sends your access token to <code>{serverUrl}/api/reports</code>, a route behind{' '}
                <code>requirePlan</code> from <code>@mesub/node</code>.
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={call}>
                    GET /api/reports
                </button>
            </div>
            {failure && (
                <p className="alert" style={{ marginTop: 12 }}>
                    {failure}
                </p>
            )}
            {answer && (
                <>
                    <p className="hint" style={{ marginTop: 12 }}>
                        <span className={`pill ${answer.status === 200 ? 'on' : 'off'}`}>
                            {answer.status}
                        </span>{' '}
                        {meaning[answer.status] ?? ''}
                    </p>
                    <pre style={{ marginTop: 8 }}>{answer.body}</pre>
                </>
            )}
        </section>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {publishableKey ? (
            <MesubProvider publishableKey={publishableKey} apiUrl={apiUrl}>
                <Session />
            </MesubProvider>
        ) : (
            <p>
                Set VITE_MESUB_PUBLISHABLE_KEY in playground/.env.local, see playground/README.md.
            </p>
        )}
    </StrictMode>,
);
