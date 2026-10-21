import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';

const MAX = 6000;

/** What the guardrails do, shown next to the editable context so admins know what's built in. */
const GUARDRAILS = [
  [
    'Grounded answers',
    'Store data comes from tool results only. An answer with prices or order numbers but no tool call is sent back once to be checked.',
  ],
  [
    'On topic',
    'Questions outside the store and its connected services get a short, polite refusal.',
  ],
  [
    'Jailbreak screening',
    'Messages that try to override the rules or extract the instructions are refused before they reach the model.',
  ],
  [
    'Untrusted tool output',
    'Tool descriptions and results are treated as data; instructions inside them are never followed.',
  ],
  [
    'Approval for changes',
    'Tools that may change data irreversibly (for example an order status) wait for the user to approve the exact call.',
  ],
  [
    'No secrets in answers',
    'API keys, tokens and internal addresses are removed from tool results and answers.',
  ],
] as const;

export function AssistantPage() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['assistant'], queryFn: api.assistantSettings });
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: (context: string) => api.saveAssistantSettings(context),
    onSuccess: (data) => {
      client.setQueryData(['assistant'], data);
      setText(data.settings.context);
    },
  });
  useEffect(() => {
    if (settings.data) setText(settings.data.settings.context);
  }, [settings.data]);

  if (settings.isPending) return <Spinner />;
  const current = settings.data?.settings;
  const changed = current ? text.trim() !== current.context.trim() : false;

  return (
    <>
      <PageHeader
        title="Assistant"
        description="What the chat assistant knows about your business. It's added to the assistant's instructions on every turn; live data such as products and orders always comes from the tools."
      />
      <div className="card stack">
        <div className="row">
          <strong>Business context</strong>
          {current?.source === 'custom' ? (
            <Badge tone="info">Custom</Badge>
          ) : (
            <Badge>Deployment default</Badge>
          )}
          {current?.updatedAt ? (
            <span className="muted small">saved {dateTime(current.updatedAt)}</span>
          ) : null}
        </div>
        <Field
          label="Policies, catalogue and tone"
          hint={`${text.length} / ${MAX} characters. Write facts the assistant may state: what you sell, prices and currency, delivery, payment, returns and warranty.`}
        >
          <textarea
            rows={14}
            maxLength={MAX}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <ErrorNote error={settings.error ?? save.error} />
        <div className="row">
          <button
            className="btn primary"
            disabled={!changed || !text.trim() || save.isPending}
            onClick={() => save.mutate(text)}
          >
            Save
          </button>
          {current?.source === 'custom' ? (
            <button className="btn" disabled={save.isPending} onClick={() => save.mutate('')}>
              Restore the default
            </button>
          ) : null}
          {save.isSuccess && !changed ? <span className="muted small">Saved.</span> : null}
        </div>
      </div>
      <div className="card stack">
        <strong>Built-in guardrails</strong>
        <span className="muted small">
          These always apply and can't be switched off here. Permissions and the audit log are
          enforced by the gateway itself, whatever the model does.
        </span>
        <ul className="guardrails">
          {GUARDRAILS.map(([title, detail]) => (
            <li key={title}>
              <strong>{title}.</strong> {detail}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
