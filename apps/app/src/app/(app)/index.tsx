import { AppText, Card, Screen } from '@/components/ui';

export default function DashboardScreen() {
  return (
    <Screen title="Dashboard">
      <Card>
        <AppText variant="heading">Welcome</AppText>
        <AppText muted>Energy summary, macro targets and nutrient highlights will appear here.</AppText>
      </Card>
    </Screen>
  );
}
