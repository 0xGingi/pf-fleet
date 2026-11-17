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
    <div className="flex min-h-full items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div>
            <h1 className="text-base font-semibold">pf-fleet</h1>
            <p className="text-xs text-text-3">Pirate Face worker dashboard</p>
          </div>
        </div>
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
