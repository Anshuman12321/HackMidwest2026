import React, { useState } from 'react';

/** Minimal access-code gate for the hosted deployment. Calls onSuccess after the session cookie is set. */
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (response.ok) { setCode(''); onSuccess(); return; }
      setError(response.status === 401 ? 'That access code was not accepted.' : 'Sign-in failed. Try again.');
    } catch { setError('Sign-in failed. Check your connection.'); }
    finally { setBusy(false); }
  }
  return (
    <main className="login-screen" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{ width: 'min(360px, 100%)', display: 'grid', gap: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Ripple</h1>
        <p style={{ margin: 0, fontSize: 12, opacity: .7 }}>Enter the access code to open the issue workspace.</p>
        <input type="password" autoComplete="current-password" autoFocus aria-label="Access code" placeholder="Access code"
          value={code} onChange={event => setCode(event.target.value)} />
        {error && <p role="alert" style={{ margin: 0, fontSize: 11, color: '#a3321f' }}>{error}</p>}
        <button className="primary-button" type="submit" disabled={busy || !code} style={{ justifyContent: 'center' }}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </main>
  );
}
