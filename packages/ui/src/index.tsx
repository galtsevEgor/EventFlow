'use client';

import { useId, useRef, type ComponentProps, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import './styles.css';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <button type="button" className={`ef-button ef-button--${variant} ${className}`} {...props} />
  );
}

export function Field({
  label,
  error,
  ...props
}: ComponentProps<'input'> & { label: string; error?: string | undefined }) {
  const id = useId();
  return (
    <div className="ef-field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <span className="ef-field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

export function Select({
  label,
  children,
  ...props
}: ComponentProps<'select'> & { label: string }) {
  const id = useId();
  return (
    <div className="ef-field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id}>
        {children}
      </select>
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="ef-alert">
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ef-empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="ef-badge">{children}</span>;
}

export function Loading() {
  return (
    <div className="ef-skeleton" role="status">
      Загрузка…
    </div>
  );
}

export function Dialog({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ef-overlay" />
        <DialogPrimitive.Content
          className="ef-dialog"
          onOpenAutoFocus={() => {
            previousFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
          }}
        >
          <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close asChild>
            <Button variant="secondary">Закрыть</Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
