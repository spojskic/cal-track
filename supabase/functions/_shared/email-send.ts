/**
 * The sender the Edge Functions use: a POST to the fullsend API (github.com/omznc/fullsend), which speaks
 * the Resend body. Pure: fetch is injected, nothing is logged but the outcome, and an e-mail address is
 * never part of a log line. Like every other upstream call of the app it classifies instead of throwing
 * (see fetchUpstreamJson in http.ts): a mail that could not be sent is an outcome the caller decides about,
 * not an exception.
 */
import { FROM_ADDRESS, type EmailMessage } from './emails.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a send call receives: the rendered message plus its recipient. */
export type OutgoingEmail = EmailMessage & { to: string };

export type SendEmailOutcome =
  /** `id` is the fullsend e-mail id when it answers with one (tracking, metrics); null on dry runs. */
  | { ok: true; id: string | null }
  /** `reason` is a short machine token (rate_limited, http_<n>, network, timeout), never a message. */
  | { ok: false; reason: string };

export interface SendCall {
  url: string;
  init: RequestInit;
}

export type SendEmail = (
  message: OutgoingEmail,
  opts?: { dryRun?: boolean },
) => Promise<SendEmailOutcome>;

const TIMEOUT_MS = 10_000;

/**
 * Builds the sender for one Edge Function: `baseUrl` is the fullsend worker URL, `apiKey` its `fs_...`
 * key. `dryRun: true` on a call renders and logs the mail but sends nothing (local dev; the wiring turns
 * the DRY_RUN_EMAIL secret into this).
 */
export function makeSendEmail(
  fetchFn: FetchLike,
  baseUrl: string,
  apiKey: string,
  opts: { log?: (message: string, detail?: unknown) => void } = {},
): SendEmail {
  return async (message, callOpts) => {
    if (callOpts?.dryRun === true) {
      opts.log?.(
        `dry-run e-mail to ${message.to}: subject=${JSON.stringify(message.subject)}`,
        { html: message.html, text: message.text },
      );
      return { ok: true, id: null };
    }
    const url = `${baseUrl.replace(/\/$/, '')}/emails`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined,
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return {
        ok: false,
        reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      };
    }
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    let id: string | null = null;
    try {
      const body = (await res.json()) as { id?: unknown };
      if (typeof body?.id === 'string') id = body.id;
    } catch {
      // a 2xx without a JSON body is still a successful send (the id is optional)
    }
    return { ok: true, id };
  };
}
