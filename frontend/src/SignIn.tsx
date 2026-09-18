import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryClient } from './lib/query';

/**
 * The whole of the sign-in screen. It stands in for the workspace whenever
 * the server will not say who is asking, so there is no route to reach and
 * nowhere to be redirected from: signing in puts the member back on the page
 * they already had open.
 */
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password }).toString(),
      });
      if (!response.ok) {
        // Which half was wrong is deliberately not said, here or on the
        // server: the pair is either right or it is not.
        setFailure(
          response.status === 429
            ? 'Too many attempts. Wait a minute, then try again.'
            : 'That address and password do not match.',
        );
        return;
      }
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    } catch {
      setFailure('Could not reach the server. Check the connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold tracking-tight">
            Private Finances
          </CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            Sign in to the household workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                maxLength={320}
                disabled={busy}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                maxLength={512}
                disabled={busy}
              />
            </div>
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Ask the other member of the household if you cannot get in; there
              is no reset by email.
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
