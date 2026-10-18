import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { setServerBase } from '../api/serverUrl';
import { checkServer, normalizeServerAddress } from './platform';

interface Props {
  initial?: string;
  submitLabel?: string;
  onSaved: (base: string) => void;
}

// Address field + "test and save". The address is only saved once GET /api/health answers.
export default function ServerAddressForm({ initial = '', submitLabel = 'Connect', onSaved }: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const base = normalizeServerAddress(value);
    if (!base) { setError('Enter an address like 192.168.1.20:3001'); return; }
    setBusy(true);
    setError(null);
    try {
      await checkServer(base);
      setServerBase(base);
      onSaved(base);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        label="Server address"
        placeholder="http://192.168.1.20:3001"
        value={value}
        onChange={e => { setValue(e.target.value); setError(null); }}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        error={error ?? undefined}
      />
      <Button type="submit" className="w-full" disabled={busy || !value.trim()}>
        {busy ? <><Loader2 size={14} className="animate-spin" /> Testing…</> : submitLabel}
      </Button>
    </form>
  );
}
