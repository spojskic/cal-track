import { Card, AppText, Screen } from './ui';

/** Shown until Supabase env vars are configured. */
export function SetupRequired() {
  return (
    <Screen title="Almost there">
      <Card>
        <AppText variant="heading">Connect your Supabase project</AppText>
        <AppText muted>
          Copy .env.example to apps/app/.env and set EXPO_PUBLIC_SUPABASE_URL and
          EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart the dev server.
        </AppText>
      </Card>
    </Screen>
  );
}
