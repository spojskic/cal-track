// Pure rules of the app's "Create account" form (apps/app/src/lib/signup.ts, lib/function-error.ts). Like app-garmin.test.ts: the
// app has no test runner of its own, and these modules import nothing from react-native / expo / '@/'.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENERIC_FAILURE_MESSAGE,
  MAX_INVITE_CODE_LENGTH,
  NOT_AVAILABLE_MESSAGE,
  OFFLINE_MESSAGE,
  describeSignUpFailure,
  formatInviteCodeInput,
  hasErrors,
  isPlausibleEmail,
  normalizeInviteCode,
  retryText,
  utf8Length,
  validateSignUp,
  type SignUpInput,
} from '../../../apps/app/src/lib/signup.ts';
import { readFunctionFailure, toFiniteNumber } from '../../../apps/app/src/lib/function-error.ts';
import {
  MAX_INVITE_INPUT_LENGTH,
  normalizeInviteCode as serverNormalize,
  parseSignUpRequest,
  signUp,
  utf8Length as serverUtf8Length,
  type CreateUserOutcome,
  type InviteOutcome,
} from '../../../supabase/functions/_shared/signup.ts';
import { createDb } from './harness';

const GOOD: SignUpInput = {
  email: 'anna@example.com',
  password: 'correct horse',
  confirmPassword: 'correct horse',
  inviteCode: 'K7M2-9QXA-F3TW',
};

describe('app signup: invite code text', () => {
  it('normalises like the server and the database', () => {
    expect(normalizeInviteCode(' k7m2-9qxa f3tw ')).toBe('K7M29QXAF3TW');
    expect(normalizeInviteCode('---')).toBe('');
  });

  it('groups what is typed or pasted in fours, upper-cased', () => {
    expect(formatInviteCodeInput('')).toBe('');
    expect(formatInviteCodeInput('k7m')).toBe('K7M');
    expect(formatInviteCodeInput('k7m2')).toBe('K7M2'); // no dangling dash
    expect(formatInviteCodeInput('k7m29')).toBe('K7M2-9');
    expect(formatInviteCodeInput('k7m29qxaf3tw')).toBe('K7M2-9QXA-F3TW');
    expect(formatInviteCodeInput('K7M2-9QXA-F3TW')).toBe('K7M2-9QXA-F3TW'); // idempotent
    expect(formatInviteCodeInput('  k7m2 9qxa\u00a0f3tw  ')).toBe('K7M2-9QXA-F3TW'); // pasted with spaces
    expect(formatInviteCodeInput('Code: K7M2-9QXA-F3TW.')).toBe('CODE-K7M2-9QXA-F3TW'); // surrounding words are kept, the server decides
  });

  it('typing one character at a time and deleting again behaves naturally', () => {
    let field = '';
    const seen: string[] = [];
    for (const ch of 'k7m29qxaf3tw') {
      field = formatInviteCodeInput(field + ch);
      seen.push(field);
    }
    expect(seen[3]).toBe('K7M2');
    expect(seen[4]).toBe('K7M2-9');
    expect(seen[11]).toBe('K7M2-9QXA-F3TW');
    // backspace removes the last visible character; a trailing dash disappears with the next formatting pass
    expect(formatInviteCodeInput('K7M2-9QXA-F3TW'.slice(0, -1))).toBe('K7M2-9QXA-F3T');
    expect(formatInviteCodeInput('K7M2-9'.slice(0, -1))).toBe('K7M2');
  });

  it('caps the length so the grouped text always fits the server limit of 32 characters', () => {
    const shown = formatInviteCodeInput('a'.repeat(100));
    expect(normalizeInviteCode(shown)).toHaveLength(MAX_INVITE_CODE_LENGTH);
    expect(shown.length).toBeLessThanOrEqual(MAX_INVITE_INPUT_LENGTH);
  });

  it('client and server normalisation agree on every input', () => {
    for (const s of [
      '',
      'abc',
      'K7M2-9QXA-F3TW',
      ' k7m2 9qxa f3tw ',
      'ÅÄÖ-ćčš-123',
      '\u2013\u2013',
      'a_b.c/d',
      '😀ab12',
      'ǅ',
    ]) {
      expect(normalizeInviteCode(s), s).toBe(serverNormalize(s));
    }
  });

  describe('against the database', () => {
    let db: PGlite;
    beforeAll(async () => {
      db = await createDb();
    });
    afterAll(async () => {
      await db.close();
    });

    it('private.normalize_invite_code and the app agree on every input', async () => {
      for (const s of [
        '',
        'abc',
        'K7M2-9QXA-F3TW',
        ' k7m2 9qxa f3tw ',
        'ÅÄÖ-ćčš-123',
        '\u2013\u2013',
        'a_b.c/d',
        '😀ab12',
        'ǅ',
        'k7m2\u00a09qxa',
      ]) {
        const r = await db.query<{ n: string }>('select private.normalize_invite_code($1) as n', [
          s,
        ]);
        expect(r.rows[0]!.n, JSON.stringify(s)).toBe(normalizeInviteCode(s));
      }
    });

    it('private.format_invite_code groups like formatInviteCodeInput (for complete groups)', async () => {
      for (const s of ['K7M29QXAF3TW', 'ABCDEFGH2345', 'ABCDEFGH', 'ABCDEFGHJKMN']) {
        const r = await db.query<{ f: string }>('select private.format_invite_code($1) as f', [s]);
        expect(r.rows[0]!.f).toBe(formatInviteCodeInput(s));
      }
    });
  });
});

describe('app signup: form validation', () => {
  it('accepts a complete, matching form', () => {
    expect(validateSignUp(GOOD)).toEqual({});
    expect(hasErrors(validateSignUp(GOOD))).toBe(false);
  });

  it.each([
    ['empty e-mail', { email: '' }, { email: 'Enter your e-mail address.' }],
    ['blank e-mail', { email: '   ' }, { email: 'Enter your e-mail address.' }],
    ['e-mail without @', { email: 'anna.example.com' }, { email: 'Enter a valid e-mail address.' }],
    [
      'e-mail without a domain dot',
      { email: 'anna@example' },
      { email: 'Enter a valid e-mail address.' },
    ],
    [
      'short password',
      { password: '1234567', confirmPassword: '1234567' },
      { password: 'Use at least 8 characters.' },
    ],
    [
      'password over 72 bytes',
      { password: 'ć'.repeat(37), confirmPassword: 'ć'.repeat(37) },
      { password: 'Use at most 72 characters.' },
    ],
    ['empty confirmation', { confirmPassword: '' }, { confirmPassword: 'Repeat the password.' }],
    [
      'different confirmation',
      { confirmPassword: 'correct horsE' },
      { confirmPassword: 'The passwords do not match.' },
    ],
    [
      'empty code',
      { inviteCode: '' },
      { inviteCode: 'Enter the full invite code from your invitation.' },
    ],
    [
      'incomplete code',
      { inviteCode: 'K7M2' },
      { inviteCode: 'Enter the full invite code from your invitation.' },
    ],
    [
      'code of separators',
      { inviteCode: '----' },
      { inviteCode: 'Enter the full invite code from your invitation.' },
    ],
  ] as const)('reports %s', (_label, change, expected) => {
    expect(validateSignUp({ ...GOOD, ...change })).toEqual(expected);
  });

  it('reports every wrong field at once', () => {
    expect(
      Object.keys(
        validateSignUp({ email: 'x', password: 'y', confirmPassword: 'z', inviteCode: '' }),
      ).sort(),
    ).toEqual(['confirmPassword', 'email', 'inviteCode', 'password']);
  });

  it('trims the e-mail like the server does; the password keeps its spaces', () => {
    expect(validateSignUp({ ...GOOD, email: '  anna@example.com  ' })).toEqual({});
    expect(
      validateSignUp({ ...GOOD, password: '  spaced  ', confirmPassword: '  spaced  ' }),
    ).toEqual({});
    expect(validateSignUp({ ...GOOD, password: '  spaced  ', confirmPassword: 'spaced' })).toEqual({
      confirmPassword: 'The passwords do not match.',
    });
  });

  it('counts UTF-8 bytes like the server', () => {
    for (const s of ['', 'abc', 'ć', 'ćčš', '€', '😀', 'a😀b', 'x'.repeat(100)]) {
      expect(utf8Length(s), s).toBe(serverUtf8Length(s));
      expect(utf8Length(s), s).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });

  it('never lets through a form the server would refuse (e-mail, password, code shape)', () => {
    const emails = [
      '',
      ' ',
      'a',
      'a@b',
      'a@b.c',
      'a@b.co',
      ' a@b.co ',
      'a b@c.de',
      'a@b@c.de',
      'a@@b.co',
      '@b.co',
      'a@.co',
      `${'x'.repeat(250)}@b.co`,
      'ünï@exämple.com',
    ];
    const passwords = [
      '',
      'short',
      '1234567',
      '12345678',
      'p'.repeat(72),
      'p'.repeat(73),
      'ć'.repeat(36),
      'ć'.repeat(37),
      '😀'.repeat(18),
      '😀'.repeat(19),
    ];
    const codes = [
      '',
      'K7M2',
      'K7M2-9QXA-F3TW',
      'k7m2 9qxa f3tw',
      '--',
      'A'.repeat(24),
      'A'.repeat(33),
    ];
    for (const email of emails)
      for (const password of passwords)
        for (const inviteCode of codes) {
          const input = {
            email,
            password,
            confirmPassword: password,
            inviteCode: formatInviteCodeInput(inviteCode),
          };
          const clientOk = !hasErrors(validateSignUp(input));
          const serverOk = !(
            'status' in
            (parseSignUpRequest({ email, password, inviteCode: input.inviteCode }) as object)
          );
          if (clientOk)
            expect(serverOk, JSON.stringify({ email, password: password.length, inviteCode })).toBe(
              true,
            );
        }
    // and the plain e-mail rule is the same one
    for (const email of emails) {
      const serverOk = !(
        'status' in
        (parseSignUpRequest({ email, password: '12345678', inviteCode: 'ABCD-EFGH' }) as object)
      );
      expect(isPlausibleEmail(email), email).toBe(serverOk);
    }
  });
});

describe('app signup: server answers -> messages', () => {
  const failure = (
    code: string | null,
    status: number | null = 403,
    retryAfterSeconds: number | null = null,
  ) => describeSignUpFailure({ status, code, retryAfterSeconds });

  it('maps every stable error code of the Edge Function to friendly text', () => {
    expect(failure('invite_invalid')).toEqual({
      message: 'That invite code is not valid.',
      field: 'inviteCode',
    });
    expect(failure('invite_revoked')).toEqual({
      message: 'That invite code is not valid.',
      field: 'inviteCode',
    });
    expect(failure('invalid_invite_code', 400)).toEqual({
      message: 'That invite code is not valid.',
      field: 'inviteCode',
    });
    expect(failure('invite_expired')).toEqual({
      message: 'That code has expired.',
      field: 'inviteCode',
    });
    expect(failure('invite_used_up')).toEqual({
      message: 'That code has already been used.',
      field: 'inviteCode',
    });
    expect(failure('email_taken', 409)).toEqual({
      message: 'An account with this e-mail already exists. Try signing in.',
      field: 'email',
    });
    expect(failure('invalid_email', 400)).toEqual({
      message: 'Enter a valid e-mail address.',
      field: 'email',
    });
    expect(failure('invalid_password', 400)).toEqual({
      message: 'Use 8 to 72 characters for the password.',
      field: 'password',
    });
  });

  it('rate limits name the wait in minutes', () => {
    expect(failure('rate_limited', 429, 37)).toEqual({
      message: 'Too many attempts. Try again in 1 minute.',
    });
    expect(failure('rate_limited', 429, 61)).toEqual({
      message: 'Too many attempts. Try again in 2 minutes.',
    });
    expect(failure('rate_limited', 429, 600)).toEqual({
      message: 'Too many attempts. Try again in 10 minutes.',
    });
    expect(failure(null, 429, null)).toEqual({
      message: 'Too many attempts. Try again in a few minutes.',
    });
    expect(retryText(0)).toBe('in a few minutes');
    expect(retryText(Number.NaN)).toBe('in a few minutes');
    expect(retryText(1)).toBe('in 1 minute');
    expect(retryText(60)).toBe('in 1 minute');
    expect(retryText(3599)).toBe('in 60 minutes');
  });

  it('distinguishes offline, a missing function and everything else', () => {
    expect(failure(null, null)).toEqual({ message: OFFLINE_MESSAGE });
    expect(failure(null, 404)).toEqual({ message: NOT_AVAILABLE_MESSAGE });
    expect(failure('internal_error', 500)).toEqual({ message: GENERIC_FAILURE_MESSAGE });
    expect(failure(null, 502)).toEqual({ message: GENERIC_FAILURE_MESSAGE });
    expect(failure('something_new', 418)).toEqual({ message: GENERIC_FAILURE_MESSAGE });
  });

  it('understands every answer the real handler can give (contract with supabase/functions/_shared/signup.ts)', async () => {
    const body = {
      email: 'anna@example.com',
      password: 'correct horse',
      inviteCode: 'K7M2-9QXA-F3TW',
    };
    const run = async (over: {
      invite?: InviteOutcome;
      created?: CreateUserOutcome;
      wait?: number;
      payload?: unknown;
    }) => {
      const res = await signUp(over.payload ?? body, {
        consumeRateLimit: async () => over.wait ?? 0,
        consumeInvite: async () => over.invite ?? 'ok',
        releaseInvite: async () => {},
        createUser: async () => over.created ?? { kind: 'created' },
        clientKey: '11111111-2222-4333-8444-555555555555',
      });
      const b = res.body as { error?: string; retryAfterSeconds?: number };
      return {
        status: res.status,
        code: b.error ?? null,
        retryAfterSeconds: b.retryAfterSeconds ?? null,
      };
    };

    const answers = [
      await run({ invite: 'invalid' }),
      await run({ invite: 'revoked' }),
      await run({ invite: 'expired' }),
      await run({ invite: 'used_up' }),
      await run({ created: { kind: 'email_taken' } }),
      await run({ created: { kind: 'invalid_email' } }),
      await run({ created: { kind: 'invalid_password' } }),
      await run({ wait: 90 }),
      await run({ payload: { ...body, inviteCode: '' } }),
      await run({ payload: { ...body, email: 'x' } }),
      await run({ payload: { ...body, password: 'x' } }),
    ];
    expect(answers.map((a) => a.status)).toEqual([
      403, 403, 403, 403, 409, 400, 400, 429, 400, 400, 400,
    ]);
    for (const answer of answers) {
      const text = describeSignUpFailure(answer);
      expect(text.message, JSON.stringify(answer)).not.toBe(GENERIC_FAILURE_MESSAGE);
      expect(text.message, JSON.stringify(answer)).not.toBe(OFFLINE_MESSAGE);
    }
    expect(describeSignUpFailure(answers[7]!).message).toBe(
      'Too many attempts. Try again in 2 minutes.',
    );
    // the success answer is not a failure
    expect(await run({})).toEqual({ status: 201, code: null, retryAfterSeconds: null });
  });
});

describe('app function-error: reading supabase-js function errors', () => {
  const httpError = (status: number, body: string, headers: Record<string, string> = {}) => ({
    name: 'FunctionsHttpError',
    context: new Response(body, { status, headers }),
  });

  it('reads status, JSON body and Retry-After of a FunctionsHttpError', async () => {
    const f = await readFunctionFailure(
      httpError(429, JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 90 }), {
        'Retry-After': '90',
      }),
    );
    expect(f).toEqual({
      status: 429,
      body: { error: 'rate_limited', retryAfterSeconds: 90 },
      retryAfter: 90,
    });
  });

  it('keeps the status when the body is not a JSON object', async () => {
    expect(await readFunctionFailure(httpError(502, '<html>bad gateway</html>'))).toEqual({
      status: 502,
      body: null,
      retryAfter: null,
    });
    expect(await readFunctionFailure(httpError(500, '[1,2]'))).toEqual({
      status: 500,
      body: null,
      retryAfter: null,
    });
    expect(
      await readFunctionFailure(
        httpError(
          404,
          JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }),
        ),
      ),
    ).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND' },
    });
  });

  it('answers status null when there was no HTTP answer (network, relay, unknown errors)', async () => {
    const none = { status: null, body: null, retryAfter: null };
    expect(
      await readFunctionFailure({
        name: 'FunctionsFetchError',
        context: new TypeError('Failed to fetch'),
      }),
    ).toEqual(none);
    expect(await readFunctionFailure({ name: 'FunctionsRelayError' })).toEqual(none);
    expect(await readFunctionFailure(null)).toEqual(none);
    expect(await readFunctionFailure(new Error('boom'))).toEqual(none);
  });

  it('toFiniteNumber is lenient about strings and strict about junk', () => {
    expect(toFiniteNumber('90')).toBe(90);
    expect(toFiniteNumber(12.5)).toBe(12.5);
    for (const v of [null, undefined, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY])
      expect(toFiniteNumber(v)).toBeNull();
  });
});
