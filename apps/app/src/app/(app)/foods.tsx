import { AppText, Card, Screen } from '@/components/ui';

export default function FoodsScreen() {
  return (
    <Screen title="Foods">
      <Card>
        <AppText variant="heading">Your foods</AppText>
        <AppText muted>Favorites, custom foods, recipes and saved meals will appear here.</AppText>
      </Card>
    </Screen>
  );
}
