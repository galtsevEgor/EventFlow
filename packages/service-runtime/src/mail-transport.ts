import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { operation } from '@eventflow/telemetry';

const defaultSmtpHost = '127.0.0.1';
const defaultSmtpPort = 11025;
const smtpConnectionTimeoutMs = 3_000;
const smtpGreetingTimeoutMs = 3_000;
const smtpSocketTimeoutMs = 5_000;
const messageDomain = 'eventflow.test';

export const mailConfig = {
  PUBLIC_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href === url.origin + '/';
  }),
  MAILPIT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(defaultSmtpPort),
  MAILPIT_SMTP_HOST: z.enum([defaultSmtpHost, 'mailpit']).default(defaultSmtpHost),
  MAIL_DELIVERY_DISABLED: z.enum(['false', 'true']).default('false'),
};

export class Mailpit {
  private readonly transport;

  constructor(
    port: number,
    private readonly source: 'tickets' | 'catalog' | 'waitlist',
    host: string = defaultSmtpHost,
  ) {
    this.transport = createTransport({
      host,
      port,
      ignoreTLS: true,
      connectionTimeout: smtpConnectionTimeoutMs,
      greetingTimeout: smtpGreetingTimeoutMs,
      socketTimeout: smtpSocketTimeoutMs,
    });
  }

  async send(id: string, to: string, subject: string, text: string) {
    const result = await operation('mail.smtp', () =>
      this.transport.sendMail({
        from: `EventFlow <hello@${messageDomain}>`,
        to: { name: '', address: to },
        subject,
        text,
        messageId: `<${this.source}-${id}@${messageDomain}>`,
      }),
    );
    if (result.accepted.length !== 1) throw new Error('Message was not accepted');
    return 'SENT' as const;
  }
}
