import { describe, expect, it } from 'vitest';
import { APP_URL, FROM_ADDRESS, friendRequestEmail, inviteEmail } from '../../../supabase/functions/_shared/emails.ts';

// The web app lives on its own subdomain and the sending domain is the same one.
describe('addresses', () => {
  it('the app URL and the sender use ration.safetpojskic.com', () => {
    expect(APP_URL).toBe('https://ration.safetpojskic.com');
    expect(FROM_ADDRESS).toBe('Ration <no-reply@ration.safetpojskic.com>');
  });
});

// The two transactional e-mails of the app (the invite with its code and the friend request), rendered by
// supabase/functions/_shared/emails.ts. The look follows the app's default theme (Kanagawa Lotus, Boxy corners);
// what the tests pin is what a recipient (or a spam filter) needs: both an HTML and a plain-text part, the invite
// code and the app link in both, and a dark-mode variant as a progressive enhancement.
describe('emails', () => {
  describe('inviteEmail', () => {
    const mail = inviteEmail({ code: 'K7M2-9QXA-F3TW', validDays: 14 });

    it('has a subject and BOTH an HTML and a plain-text part', () => {
      expect(mail.subject).toBe("You're invited to Ration");
      expect(mail.html).toMatch(/<table/i);
      expect(mail.text.trim().length).toBeGreaterThan(0);
    });

    it('the code (with its dashes) and the app link appear in both parts', () => {
      expect(mail.html).toContain('K7M2-9QXA-F3TW');
      expect(mail.text).toContain('K7M2-9QXA-F3TW');
      expect(mail.html).toContain(APP_URL);
      expect(mail.text).toContain(APP_URL);
    });

    it('the expiry is mentioned when the code has one, and stays out when it has none', () => {
      expect(mail.html).toMatch(/14 days/i);
      expect(mail.text).toMatch(/14 days/i);
      const never = inviteEmail({ code: 'K7M2-9QXA-F3TW', validDays: null });
      expect(never.html).not.toMatch(/expires in|no expiry/i);
      expect(never.text).not.toMatch(/expires in|no expiry/i);
    });

    it('links to the given app URL when one is passed', () => {
      const other = inviteEmail({ code: 'K7M2-9QXA-F3TW', appUrl: 'https://staging.example.com' });
      expect(other.html).toContain('https://staging.example.com');
      expect(other.text).toContain('https://staging.example.com');
      expect(other.html).not.toContain(APP_URL);
    });

    it('is styled like the app: Boxy corners and a dark-mode variant', () => {
      expect(mail.html).toMatch(/border-radius:\s*0/);
      expect(mail.html).toMatch(/prefers-color-scheme:\s*dark/i);
    });

    it('sits on a white base, not the app\'s Kanagawa paper (e-mail clients and spam filters expect neutral mail)', () => {
      expect(mail.html).toContain('#FFFFFF');
      expect(mail.html).not.toContain('#F2ECBC'); // Kanagawa Lotus background
      expect(mail.html).not.toContain('#F8F4D6'); // Kanagawa Lotus surface
    });
  });

  describe('friendRequestEmail', () => {
    const mail = friendRequestEmail({ displayName: 'Anna' });

    it('the subject names the person who sent the request', () => {
      expect(mail.subject).toBe('Anna wants to be your friend on Ration');
    });

    it('the name and the app link appear in both parts', () => {
      expect(mail.html).toContain('Anna');
      expect(mail.text).toContain('Anna');
      expect(mail.html).toContain(APP_URL);
      expect(mail.text).toContain(APP_URL);
    });

    it('falls back to a blank-friendly name and is styled like the app', () => {
      const blank = friendRequestEmail({ displayName: '   ' });
      expect(blank.subject).not.toMatch(/\s{2,}|^  /);
      expect(blank.subject).toMatch(/wants to be your friend on Ration$/);
      expect(mail.html).toMatch(/border-radius:\s*0/);
      expect(mail.html).toMatch(/prefers-color-scheme:\s*dark/i);
    });
  });

  it('the sender is Ration on the app subdomain', () => {
    expect(FROM_ADDRESS).toBe('Ration <no-reply@ration.safetpojskic.com>');
  });
});
