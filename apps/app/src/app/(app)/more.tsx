import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function MoreScreen() {
  const { session, signOut } = useAuth();
  return (
    <Screen title="More">
      <Card>
        <AppText variant="heading">Account</AppText>
        <AppText muted>{session?.user.email}</AppText>
        <Button label="Sign out" variant="secondary" onPress={signOut} />
      </Card>
    </Screen>
  );
}
