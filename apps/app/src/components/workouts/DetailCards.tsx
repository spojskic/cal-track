import type { UnitSystem } from '@ration/core';
import type { WorkoutDetails } from '@ration/garmin';
import { View, StyleSheet } from 'react-native';

import { KeyValueRow, Divider } from '@/components/settings/rows';
import { AppText, Card } from '@/components/ui';
import type { WorkoutEntry } from '@/data/workouts';
import { spacing } from '@/theme';

import { formatRest, formatSetGroup, setTotals, summarizeSets } from './format';
import { lapLine, summarySections } from './summary';
import { ZoneBar } from './ZoneBar';

/** The facts under the workout's title: summary, heart rate, training effect. Only rows that have a value. */
export function SummaryCards({ entry, system }: { entry: WorkoutEntry; system: UnitSystem }) {
  const sections = summarySections(entry, system);
  return (
    <>
      {sections.map((section) => (
        <Card key={section.key}>
          <AppText variant="heading">{section.title}</AppText>
          {section.rows.map((row, i) => (
            <View key={row.key}>
              {i > 0 ? <Divider /> : null}
              <KeyValueRow label={row.label} value={row.value} {...(row.hint ? { hint: row.hint } : {})} />
            </View>
          ))}
        </Card>
      ))}
    </>
  );
}

export function ZonesCard({ details }: { details: WorkoutDetails | null }) {
  if (!details?.hrZones || details.hrZones.length === 0) return null;
  return (
    <Card>
      <AppText variant="heading">Time in heart-rate zones</AppText>
      <ZoneBar zones={details.hrZones} />
    </Card>
  );
}

/** Strength sessions: the sets summarised per exercise ("Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg"). */
export function SetsCard({ details, system }: { details: WorkoutDetails | null; system: UnitSystem }) {
  if (!details?.sets || details.sets.length === 0) return null;
  const groups = summarizeSets(details.sets);
  const totals = setTotals(details.sets);
  const guessed = groups.some((g) => g.guess);
  const headline = [
    `${totals.sets} ${totals.sets === 1 ? 'set' : 'sets'}`,
    totals.reps > 0 ? `${totals.reps} reps` : null,
    totals.medianRestSec !== null ? `about ${formatRest(totals.medianRestSec)} rest between sets` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Card>
      <AppText variant="heading">Sets</AppText>
      <AppText muted>{headline}</AppText>
      <View style={styles.groups}>
        {groups.map((group) => (
          <AppText key={group.exercise ?? 'unnamed'} accessibilityLabel={formatSetGroup(group, system)}>
            {formatSetGroup(group, system)}
          </AppText>
        ))}
      </View>
      {guessed ? (
        <AppText variant="small" muted>
          Exercise names are the watch&apos;s guess from wrist motion. Weights only appear when you typed them into Garmin Connect.
        </AppText>
      ) : null}
    </Card>
  );
}

/** Laps / splits (at most 20 are stored). */
export function LapsCard({ details, system }: { details: WorkoutDetails | null; system: UnitSystem }) {
  if (!details?.laps || details.laps.length < 2) return null;
  return (
    <Card>
      <AppText variant="heading">Laps</AppText>
      <View style={styles.groups}>
        {details.laps.map((lap) => (
          <View key={lap.index} style={styles.lap}>
            <AppText muted style={styles.lapIndex}>
              {lap.index}
            </AppText>
            <AppText>{lapLine(lap, system)}</AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  groups: { gap: spacing.sm },
  lap: { flexDirection: 'row', gap: spacing.md },
  lapIndex: { width: 24 },
});
