import { AppText, Card, Screen } from '@/components/ui';

export default function DiaryScreen() {
  return (
    <Screen title="Diary">
      <Card>
        <AppText variant="heading">Today</AppText>
        <AppText muted>Meal groups and logged foods will appear here.</AppText>
      </Card>
    </Screen>
  );
}
