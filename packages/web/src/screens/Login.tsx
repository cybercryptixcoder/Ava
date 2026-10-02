import { useState } from "react";
import { api } from "../lib/api";
import { Button, ErrorLine } from "../components/ui";

export function Login({ passwordSet, onDone }: { passwordSet: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { password: pw });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <div className="login-card">
        <span className="dial-mark login-mark" aria-hidden="true" />
        <h1 className="login-title">Ava</h1>
        {passwordSet ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="label" htmlFor="pw">
              Password
            </label>
            <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <ErrorLine error={error} />
            <Button kind="primary" type="submit" busy={busy} disabled={!pw}>
              Sign in
            </Button>
          </form>
        ) : (
          <p className="login-note">
            No password is set. Run <code>npm run hash-password</code>, put the result in <code>AVA_PASSWORD_HASH</code>, and restart. Until then Ava only answers on this machine.
          </p>
        )}
      </div>
    </main>
  );
}
