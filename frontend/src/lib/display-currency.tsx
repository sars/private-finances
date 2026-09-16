import { useUrlSearch, useSearchPatch } from './navigation';
import { validDisplay } from './navigation-state';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Choice } from '@/components/finance';
const currencies = ['UAH', 'EUR', 'USD', 'GBP'];
const Context = createContext({
  currency: 'UAH',
  setCurrency: (_value: string) => {},
});
export function DisplayCurrencyProvider({ children }: { children: ReactNode }) {
  const search = useUrlSearch();
  const patch = useSearchPatch();
  const [saved] = useState(() => {
    try {
      return validDisplay(localStorage.getItem('pf-display-currency')) ?? 'UAH';
    } catch {
      return 'UAH';
    }
  });
  const currency = validDisplay(search.display) ?? saved;
  useEffect(() => {
    try {
      localStorage.setItem('pf-display-currency', currency);
    } catch {}
  }, [currency]);
  function setCurrency(value: string) {
    if (validDisplay(value)) patch({ display: value });
  }
  return (
    <Context.Provider value={{ currency, setCurrency }}>
      {children}
    </Context.Provider>
  );
}
export const useDisplayCurrency = () => useContext(Context);
export function CurrencyControl() {
  const { currency, setCurrency } = useDisplayCurrency();
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-muted-foreground sm:inline">
        Display currency
      </span>
      <Choice
        aria-label="Display currency"
        size="sm"
        className="w-20"
        value={currency}
        onChange={setCurrency}
        options={currencies.map((code) => ({ value: code, label: code }))}
      />
    </div>
  );
}
