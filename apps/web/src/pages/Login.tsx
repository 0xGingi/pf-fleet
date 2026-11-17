import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { ApiError, post } from "@/lib/api";

export function Login() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center text-center">
        <img src="/logo.png" alt="" className="size-20" />
        <h1 className="mt-3 font-display text-4xl">Pirate Face Fleet</h1>
        <p className="mt-1 text-[15px] text-text-3">Your Pirate Face workers, on every machine</p>
      </div>
      <Card className="w-full max-w-sm p-6">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await post("/api/auth/login", { username, password });
              await qc.invalidateQueries();
              navigate("/", { replace: true });
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "could not reach the dashboard");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Username" htmlFor="u">
            <Input id="u" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label="Password" htmlFor="p" error={error}>
            <Input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
