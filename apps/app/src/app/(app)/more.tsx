import { router, type Href } from 'expo-router';

import { useAiGate } from '@/ai/use-ai-gate';
import { Divider, NavRow } from '@/components/settings/rows';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';

// The AI settings route is built separately; cast so this compiles before and after it exists.
const AI_SETTINGS = '/settings/ai' as unknown as Href;
const COACH = '/coach' as unknown as Href;

interface MenuItem {
  label: string;
  description: string;
  href: Href;
}

const MENU: MenuItem[] = [
  {
    label: 'Profile & targets',
    description: 'Energy and macro targets, weight goal, BMR and activity',
    href: '/settings/targets',
  },
  {
    label: 'Personal details',
    description: 'Sex, birthdate, height, log your weight',
    href: '/settings/profile',
  },
  {
    label: 'Nutrient targets',
    description: 'Vitamins, minerals and other daily targets',
    href: '/settings/nutrients',
  },
  { label: 'Display & units', description: 'Metric or imperial units, appearance', href: '/settings/display' },
  {
    label: 'Connected apps & devices',
    description: 'Apple Health, Health Connect, Garmin',
    href: '/settings/integrations' as unknown as Href,
  },
];

export default function MoreScreen() {
  const { session, signOut } = useAuth();
  const ai = useAiGate();

  return (
    <Screen title="More">
      <Card>
        {MENU.map((item, i) => (
          <MenuRow key={item.label} item={item} first={i === 0} />
        ))}
        {ai.enabled ? (
          <>
            <Divider />
            <NavRow
              label="Coach"
              description="Chat about your nutrition, training and recovery"
              onPress={() => router.push(COACH)}
            />
          </>
        ) : null}
        <Divider />
        <NavRow
          label={ai.enabled ? 'AI Coach & keys' : 'AI (optional)'}
          description={ai.enabled ? 'Manage your AI key, model and coach' : 'Connect your own key to enable AI features'}
          onPress={() => router.push(AI_SETTINGS)}
        />
        <Divider />
        <NavRow label="About" description="Version, data sources and licences" onPress={() => router.push('/settings/about')} />
      </Card>

      <Card>
        <AppText variant="heading">Account</AppText>
        <AppText muted accessibilityLabel={`Signed in as ${session?.user.email ?? 'unknown'}`}>
          {session?.user.email}
        </AppText>
        <Button label="Sign out" variant="secondary" onPress={signOut} />
      </Card>
    </Screen>
  );
}

function MenuRow({ item, first }: { item: MenuItem; first: boolean }) {
  return (
    <>
      {first ? null : <Divider />}
      <NavRow label={item.label} description={item.description} onPress={() => router.push(item.href)} />
    </>
  );
}
