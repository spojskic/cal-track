// The public web app the app links out to (and the one the e-mails link to). The invite e-mail builds its link in
// the Edge Functions (supabase/functions/_shared/emails.ts APP_URL); the client needs the same address for the
// password-reset flow: resetPasswordForEmail's redirectTo must be the /reset-password route the recovery link opens.
// Overridable for local development with EXPO_PUBLIC_APP_URL (Expo inlines EXPO_PUBLIC_* at build time).
export const APP_URL = process.env.EXPO_PUBLIC_APP_URL ?? 'https://ration.safetpojskic.com';
