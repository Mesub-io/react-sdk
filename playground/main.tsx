import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MesubProvider, useMesub } from '@mesub/react';

import './style.css';

const publishableKey = import.meta.env['VITE_MESUB_PUBLISHABLE_KEY'] ?? '';
const apiUrl = import.meta.env['VITE_MESUB_API_URL'] ?? 'http://localhost:3333';

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
