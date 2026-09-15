import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDisplayCurrency } from './lib/display-currency';
import { useSession, invalidateFinancialData } from './lib/query';
import { rigaCalendarDate, validCashAmount } from './lib/cash-entry';

export default function Cash() {
  const { currency: display } = useDisplayCurrency();
  const { data: session } = useSession();
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(display);
  const [date, setDate] = useState(rigaCalendarDate);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    const value = amount.trim().replace(',', '.');
    if (!validCashAmount(value) || !description.trim()) {
      setError(
        'Enter a positive amount with up to two decimal places and describe the purchase.',
      );
      return;
    }
    const payload = {
      amount: value,
      currency,
      date,
      description: description.trim(),
    };
    const key = JSON.stringify(payload);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/cash-transactions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          ...payload,
          csrf: session.csrf,
          requestId: request.current.id,
        }),
      });
      if (!response.ok)
        throw new Error(
          'Could not confirm this cash expense. Retry with the same details to check safely.',
        );
      const result = await response.json();
      if (typeof result.transactionId !== 'string')
        throw new Error(
          'Could not confirm the saved payment. Retry with the same details.',
        );
      await invalidateFinancialData();
      await router.navigate({
        to: '/review' as string,
        search: { id: result.transactionId, display } as Record<string, string>,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save the cash expense.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Button variant="ghost" asChild>
        <a href={'/review?display=' + display}>← Transactions</a>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Add cash expense
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Record a purchase paid in cash. We’ll save your explanation and
          suggest a category for you to confirm.
        </p>
      </div>
      <form
        onSubmit={save}
        className="space-y-5 rounded-xl border bg-card p-4 sm:p-6"
      >
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cash-amount">Amount paid</Label>
              <Input
                id="cash-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cash-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="cash-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['UAH', 'EUR', 'USD', 'GBP'].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cash-description">What did you pay for?</Label>
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
              id="cash-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="For example, coffee and dessert at the market"
              rows={3}
              maxLength={2000}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cash-date">Purchase date</Label>
            <Input
              id="cash-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              max={rigaCalendarDate()}
              required
            />
            <p className="text-xs text-muted-foreground">
              Recorded for your account. Dates use Europe/Riga.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={!session}
          >
            {busy ? 'Saving & suggesting…' : 'Add cash expense'}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
