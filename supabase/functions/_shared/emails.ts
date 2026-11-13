/**
 * The transactional e-mails of the app (pure: only web-standard APIs, no Deno globals, no I/O).
 *
 * The look follows the app's own look, translated to what e-mail clients accept: the accent colours of the default
 * Kanagawa palettes (primary blue, ink text), Boxy corners (border-radius: 0 everywhere, the app's default), the
 * system font stack and a monospace block for the invite code - all inline, because clients strip <style> blocks.
 * The base is WHITE, not the app's Kanagawa paper: a warm yellow page background reads as a marketing mail. The
 * prefers-color-scheme media query flips to the Kanagawa Wave values in the clients that support it (Apple Mail,
 * iOS Mail); everywhere else stays light.
 *
 * Every template returns BOTH an HTML and a plain-text part: the text part keeps spam scores down and is
 * what text-only clients show. Everything user-controlled is HTML-escaped; the invite code comes from the
 * database's look-alike-free alphabet and the app URL is an environment value.
 */

/** The public web app the e-mails link to: it is deployed on this subdomain (overridable per send, e.g. staging). */
export const APP_URL = 'https://ration.safetpojskic.com';

/** The From of every Ration e-mail: the same subdomain, verified as the sending domain in Resend. */
export const FROM_ADDRESS = 'Ration <no-reply@ration.safetpojskic.com>';

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

// A white base, not the app's paper colour: e-mail clients render on white and the warm Kanagawa background reads as
// an ad. The app's identity stays in the accents (the primary blue, the ink text, Boxy corners, the mono code block);
// the card and the code block use neutral greys.
const LIGHT = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  border: '#E4E2DA',
  codeSurface: '#F6F5F1',
  text: '#43436C',
  textMuted: '#77746A',
  primary: '#4D699B',
  onPrimary: '#FFFFFF',
} as const;

// Kanagawa Wave (the app's default dark palette), for clients that honour prefers-color-scheme.
const DARK = {
  background: '#1F1F28',
  surface: '#2A2A37',
  border: '#363646',
  codeSurface: '#1F1F28',
  text: '#DCD7BA',
  textMuted: '#A09E8A',
  primary: '#7AA89F',
  onPrimary: '#1F1F28',
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO_STACK = "Menlo, Consolas, 'SF Mono', monospace";

/** Escape everything a body could inject: & < > " ' (the code is safe anyway, names are not). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The dark-mode variant: the same classes, the Wave values. Inlined in every template's <head>. */
function styleTag(): string {
  const rule = (c: Record<keyof typeof LIGHT, string>): string =>
    [
      `.ration-bg { background-color: ${c.background}; }`,
      `.ration-card { background-color: ${c.surface}; border-color: ${c.border}; }`,
      `.ration-code-block { background-color: ${c.codeSurface} !important; border-color: ${c.border}; }`,
      `.ration-text { color: ${c.text}; }`,
      `.ration-muted { color: ${c.textMuted}; }`,
      `.ration-button { background-color: ${c.primary} !important; color: ${c.onPrimary} !important; }`,
      `.ration-code { color: ${c.primary} !important; }`,
    ].join(' ');
  return `<style>@media (prefers-color-scheme: dark) { ${rule(DARK)} }</style>`;
}

/** One wrapped card on the white page background; `body` is already-escaped HTML. */
function card(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleTag()}
</head>
<body class="ration-bg" style="margin:0; padding:0; background-color:${LIGHT.background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ration-bg" style="background-color:${LIGHT.background}; border-collapse:collapse;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ration-card" style="max-width:480px; background-color:${LIGHT.surface}; border:1px solid ${LIGHT.border}; border-collapse:collapse; border-radius:0;">
  <tr><td class="ration-text" style="padding:28px 24px; font-family:${FONT_STACK}; color:${LIGHT.text}; font-size:15px; line-height:1.5;">
${inner}
  </td></tr>
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td class="ration-muted" style="padding-top:16px; font-family:${FONT_STACK}; color:${LIGHT.textMuted}; font-size:12px; line-height:1.4;">
    You received this e-mail because somebody used your address in Ration.
  </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** The CTA button of the card: the primary colour, Boxy corners. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; margin:20px 0;">
<tr><td class="ration-button" style="background-color:${LIGHT.primary}; border-radius:0;">
  <a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 24px; font-family:${FONT_STACK}; font-size:15px; font-weight:700; color:${LIGHT.onPrimary}; text-decoration:none;">${escapeHtml(label)}</a>
</td></tr>
</table>`;
}

const heading = (text: string): string =>
  `<p class="ration-text" style="margin:0 0 12px; font-size:20px; font-weight:700; color:${LIGHT.text};">${text}</p>`;

const paragraph = (text: string): string =>
  `<p class="ration-text" style="margin:0 0 12px;">${text}</p>`;

/** The invite code, big and monospaced on a contrasting block, like the app shows it. */
function codeBlock(code: string): string {
  return `<p class="ration-code-block" style="margin:20px 0; padding:16px 12px; background-color:${LIGHT.codeSurface}; border:1px solid ${LIGHT.border}; border-radius:0; font-family:${MONO_STACK}; font-size:24px; font-weight:700; letter-spacing:3px; text-align:center;">${escapeHtml(code)}</p>`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface InviteEmailInput {
  /** The code as the app shows it: XXXX-XXXX-XXXX (already grouped). */
  code: string;
  /** How long the code works, in days; null or undefined for a code that never expires. */
  validDays?: number | null;
  appUrl?: string;
  /**
   * The recipient's address: the CTA then links to the sign-up screen WITH the code and the e-mail as query
   * parameters, so the app pre-fills them ("Create your account" -> the form is almost complete). Absent keeps
   * the plain link.
   */
  to?: string;
}

/** The sign-up link of the invite: with the code and the e-mail pre-filled when the recipient is known. */
export function inviteSignUpUrl(code: string, appUrl: string, to?: string): string {
  return to ? `${appUrl}/sign-in?code=${encodeURIComponent(code)}&email=${encodeURIComponent(to)}` : `${appUrl}/sign-in`;
}

export function inviteEmail(input: InviteEmailInput): EmailMessage {
  const appUrl = input.appUrl ?? APP_URL;
  const expiry =
    input.validDays === null || input.validDays === undefined
      ? ''
      : `<p class="ration-text" style="margin:0 0 12px;">The code works for ${input.validDays} ${input.validDays === 1 ? 'day' : 'days'}.</p>`;
  const textExpiry =
    input.validDays === null || input.validDays === undefined
      ? ''
      : `The code works for ${input.validDays} ${input.validDays === 1 ? 'day' : 'days'}.\n`;
  const url = inviteSignUpUrl(input.code, appUrl, input.to);

  const html = card(
    [
      heading("You're invited to Ration"),
      paragraph(
        'You were invited to use Ration, a private calorie and nutrition tracker. Create your account with the code below:',
      ),
      codeBlock(input.code),
      expiry,
      paragraph('Tap the button: the sign-up form opens with your code and e-mail already filled in. You only choose a password.'),
      button(url, 'Create your account'),
    ].join('\n'),
  );

  const text = [
    "You're invited to Ration",
    '',
    'You were invited to use Ration, a private calorie and nutrition tracker.',
    '',
    `Your invite code: ${input.code}`,
    '',
    textExpiry,
    `Open ${url}, and the sign-up form opens with the code and your e-mail already filled in.`,
    '',
    'You received this e-mail because somebody used your address in Ration.',
  ].join('\n');

  return { subject: "You're invited to Ration", html, text };
}

export interface FriendRequestEmailInput {
  /** The display name of the person who sent the request (a blank one becomes "Somebody"). */
  displayName: string;
  appUrl?: string;
}

export function friendRequestEmail(input: FriendRequestEmailInput): EmailMessage {
  const appUrl = input.appUrl ?? APP_URL;
  const name = input.displayName.trim() || 'Somebody';
  const url = `${appUrl}/friends`;

  const html = card(
    [
      heading(`${escapeHtml(name)} wants to be your friend on Ration`),
      paragraph(
        'Once you accept, you and ' +
          escapeHtml(name) +
          ' see each other\u2019s custom foods and recipes in Ration. Nothing else is shared: no diary, weight or targets.',
      ),
      button(url, 'Open your friends'),
    ].join('\n'),
  );

  const text = [
    `${name} wants to be your friend on Ration`,
    '',
    `Once you accept, you and ${name} see each other's custom foods and recipes in Ration.`,
    'Nothing else is shared: no diary, weight or targets.',
    '',
    `Open ${url} to answer the request.`,
    '',
    'You received this e-mail because somebody used your address in Ration.',
  ].join('\n');

  return { subject: `${name} wants to be your friend on Ration`, html, text };
}
