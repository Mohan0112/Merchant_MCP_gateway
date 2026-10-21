import type { UpstreamStatus } from '@ahjin/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="alert" role="alert">
      {message}
      {requestId ? <span className="small mono"> (request {requestId})</span> : null}
    </div>
  );
}

/** Field-level message from a validation error, e.g. for "credential". */
export function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError
    ? error.fieldErrors.find((f) => f.field === field)?.message
    : undefined;
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label>{label}</label>
      {children}
      {error ? (
        <span className="error">{error}</span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

const STATUS: Record<UpstreamStatus, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'success' },
  unreachable: { label: 'Unreachable', tone: 'danger' },
  disabled: { label: 'Disabled', tone: '' },
  connecting: { label: 'Connecting', tone: 'warning' },
};

export function StatusBadge({ status }: { status: UpstreamStatus }) {
  const { label, tone } = STATUS[status];
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge plain ${tone}`}>{children}</span>;
}

export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`switch ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="code">
      {code}
      <CopyButton text={code} />
    </pre>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
