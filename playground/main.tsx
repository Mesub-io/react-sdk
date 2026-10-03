import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

import {
    ManageSubscriptions,
    MesubProvider,
    SubscribeButton,
    type MesubSubscription,
} from '@mesub/react';

import '@mesub/react/styles.css';
import './style.css';

// The local back runs on devnet.
const chain = (import.meta.env['VITE_MESUB_CHAIN'] ?? 'solana:devnet') as `solana:${string}`;

interface User {
    id: string;
    email: string | null;
}

/** A merchant's page: its own login, then the two components. Plain on purpose. */
function Page() {
    // Undefined until the server said who is signed in.
    const [user, setUser] = useState<User | null | undefined>(undefined);
    const [down, setDown] = useState(false);

    async function ask(path: string, body?: unknown) {
        try {
            const response = await fetch(path, {
                method: body === undefined ? 'GET' : 'POST',
                ...(body !== undefined && {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            if (!response.ok) throw new Error(String(response.status));
            setUser(((await response.json()) as { user: User | null }).user);
            setDown(false);
        } catch {
            setUser(null);
            setDown(true);
        }
    }

    useEffect(() => {
        void ask('/api/me');
    }, []);

    return (
        <main>
            <header>
                <h1>@mesub/react playground</h1>
                <p>
                    The widget calls <code>/api/mesub</code> on this site's own server, never Mesub.
                </p>
            </header>

            {down && (
                <p className="alert" role="alert">
                    No answer from the merchant server: start it with pnpm playground:server.
                </p>
            )}

            <Login
                user={user}
                onLogin={(id, email) => ask('/api/login', { id, email })}
                onLogout={() => ask('/api/logout', {})}
            />

            <Subscribe />

            <section className="card">
                <h2>My subscriptions</h2>
                {/* Keyed on who is signed in: another customer reads their own list. */}
                <ManageSubscriptions key={user?.id ?? 'nobody'} />
            </section>

            <CallServer />
        </main>
    );
}

/** The site's own login, which Mesub knows nothing of: a cookie set by server.mjs. */
function Login({
    user,
    onLogin,
    onLogout,
}: {
    user: User | null | undefined;
    onLogin(id: string, email: string): void;
    onLogout(): void;
}) {
    const [id, setId] = useState('customer-1');
    const [email, setEmail] = useState('');

    function submit(event: FormEvent) {
        event.preventDefault();
        if (id.trim()) onLogin(id.trim(), email.trim());
    }

    return (
        <section className="card">
            <h2>Your site's login</h2>
            <dl className="rows">
                <dt>state</dt>
                <dd>
                    <span className={`pill ${user === undefined ? 'wait' : user ? 'on' : 'off'}`}>
                        {user === undefined ? 'loading' : user ? 'signed in' : 'signed out'}
                    </span>
                </dd>
                <dt>customer</dt>
                <dd>
                    <code>{user?.id ?? '-'}</code>
                </dd>
                <dt>email</dt>
                <dd>{user?.email ?? '-'}</dd>
            </dl>
            <form className="actions" style={{ marginTop: 12 }} onSubmit={submit}>
                <label className="field">
                    your id for the customer
                    <input value={id} onChange={(event) => setId(event.target.value)} />
                </label>
                <label className="field">
                    email, for Mesub's notices
                    <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                </label>
                <button type="submit" className="primary" disabled={Boolean(user)}>
                    Sign in
                </button>
                <button type="button" onClick={onLogout} disabled={!user}>
                    Sign out
                </button>
            </form>
            <p className="hint" style={{ marginTop: 12 }}>
                Signed out, the widget's routes answer 401: it says so, and offers nothing to sign.
            </p>
        </section>
    );
}

/** A plan slug and the button, with what it settled on. */
function Subscribe() {
    const [plan, setPlan] = useState(import.meta.env['VITE_MESUB_PLAN'] ?? 'pro');
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
                <SubscribeButton key={plan} plan={plan} onSubscribed={setSubscribed} />
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
                Signs for <code>{chain}</code>. The wallet needs devnet SOL and enough of the plan's
                token for one period.
            </p>
            {subscribed && <pre>{JSON.stringify(subscribed, null, 2)}</pre>}
        </section>
    );
}

/** What the subscription is for: a route of the merchant only a subscriber gets. */
function CallServer() {
    const [answer, setAnswer] = useState<{ status: number; body: string } | null>(null);
    const [failure, setFailure] = useState('');

    async function call() {
        setFailure('');
        try {
            const response = await fetch('/api/reports');
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
            setFailure('No answer from the merchant server: start it with pnpm playground:server.');
        }
    }

    const meaning: Record<number, string> = {
        200: 'Let through: the signed-in customer has access to the plan.',
        401: 'Nobody is signed in on the site.',
        402: 'Signed in, but no access to the plan: subscribe first.',
        503: 'Mesub could not be reached to check the access.',
    };

    return (
        <section className="card">
            <h2>Call my server</h2>
            <p className="hint">
                <code>GET /api/reports</code>, a route behind <code>requirePlan</code> from{' '}
                <code>@mesub/node</code>, asked about the signed-in customer.
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
        <MesubProvider endpoint="/api/mesub" chain={chain}>
            <Page />
        </MesubProvider>
    </StrictMode>,
);
