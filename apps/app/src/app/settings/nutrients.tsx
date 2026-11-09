import {
  MACRO_DRIVEN_NUTRIENTS,
  NUTRIENT_GROUPS,
  nutrientsInGroup,
  parseNumber,
  selectTargets,
  type NutrientCode,
  type NutrientEntry,
  type Target,
  type Targets,
} from '@cal/core';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { NumberField, TextField } from '@/components/forms';
import { formatAmount, formatInt } from '@/components/settings/format';
import { Badge, Divider, Note } from '@/components/settings/rows';
import { errorMessage } from '@/components/settings/save-row';
import { AppText, Button, Card, Screen } from '@/components/ui';
import {
  useNutrientOverrides,
  useResetNutrientOverride,
  useSetNutrientOverride,
  type NutrientOverrides,
} from '@/data/goals';
import { useTargets, type ResolvedTargets } from '@/data/targets';
import { spacing, useTheme } from '@/theme';

const KIND_LABEL: Record<Target['kind'], string> = {
  RDA: 'RDA',
  AI: 'AI',
  CDRR: 'CDRR',
  ESTIMATE: 'EST',
  CUSTOM: 'CUSTOM',
};

/** Targets that come from the energy / macro targets and are edited on the Profile & targets screen. */
const MANAGED_ELSEWHERE: ReadonlySet<NutrientCode> = new Set<NutrientCode>([
  ...MACRO_DRIVEN_NUTRIENTS,
  'ENERGY_KCAL',
]);

function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? formatInt(n) : formatAmount(n);
}

function describeTarget(target: Target | undefined, unit: string): string {
  if (!target || (target.min === undefined && target.max === undefined)) return 'No target';
  if (target.min !== undefined && target.max !== undefined) return `${fmt(target.min)} to ${fmt(target.max)} ${unit}`;
  if (target.min !== undefined) return `At least ${fmt(target.min)} ${unit}`;
  return `At most ${fmt(target.max as number)} ${unit}`;
}

function boundText(n: number | undefined): string {
  return n === undefined ? '' : String(Number(n.toFixed(3)));
}

/** Inline min/max editor for one nutrient. Blank or default values mean "use the default". */
function OverrideEditor({
  nutrient,
  current,
  base,
  hasOverride,
  onDone,
}: {
  nutrient: NutrientEntry;
  current: Target | undefined;
  base: Target | undefined;
  hasOverride: boolean;
  onDone: () => void;
}) {
  const [minText, setMinText] = useState(boundText(current?.min));
  const [maxText, setMaxText] = useState(boundText(current?.max));
  const set = useSetNutrientOverride();
  const reset = useResetNutrientOverride();

  const parseBound = (text: string): { value: number | undefined; bad: boolean } => {
    if (text.trim() === '') return { value: undefined, bad: false };
    const n = parseNumber(text);
    return n === null ? { value: undefined, bad: true } : { value: n, bad: false };
  };
  const min = parseBound(minText);
  const max = parseBound(maxText);
  const effMin = min.value ?? base?.min;
  const effMax = max.value ?? base?.max;
  const rangeError =
    effMin !== undefined && effMax !== undefined && effMin > effMax ? 'The minimum cannot be above the maximum.' : null;
  const valid = !min.bad && !max.bad && !rangeError;
  const busy = set.isPending || reset.isPending;
  const error = set.error ?? reset.error;

  const save = () => {
    if (!valid) return;
    // A bound equal to the default is not an override.
    const minOverride = min.value !== undefined && min.value !== base?.min ? min.value : null;
    const maxOverride = max.value !== undefined && max.value !== base?.max ? max.value : null;
    set.mutate({ code: nutrient.code, min: minOverride, max: maxOverride }, { onSuccess: onDone });
  };

  return (
    <View style={styles.editor}>
      <View style={styles.editorFields}>
        <View style={styles.flex}>
          <NumberField
            label="Minimum"
            unit={nutrient.unit}
            value={minText}
            onChange={setMinText}
            error={min.bad ? 'Enter a number.' : null}
          />
        </View>
        <View style={styles.flex}>
          <NumberField
            label="Maximum"
            unit={nutrient.unit}
            value={maxText}
            onChange={setMaxText}
            error={max.bad ? 'Enter a number.' : null}
          />
        </View>
      </View>
      <AppText variant="small" muted>
        {`Default: ${describeTarget(base, nutrient.unit)}. Clearing a field restores its default.`}
      </AppText>
      {rangeError ? <Note tone="danger">{rangeError}</Note> : null}
      {error ? <Note tone="danger">{errorMessage(error)}</Note> : null}
      <View style={styles.editorButtons}>
        <View style={styles.flex}>
          <Button label="Save" onPress={save} loading={set.isPending} disabled={!valid || busy} />
        </View>
        {hasOverride ? (
          <View style={styles.flex}>
            <Button
              label="Reset to default"
              variant="secondary"
              onPress={() => reset.mutate(nutrient.code, { onSuccess: onDone })}
              loading={reset.isPending}
              disabled={busy}
            />
          </View>
        ) : null}
        <View style={styles.flex}>
          <Button label="Cancel" variant="ghost" onPress={onDone} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

function NutrientRow({
  nutrient,
  target,
  base,
  hasOverride,
  energyTarget,
  editing,
  onToggle,
}: {
  nutrient: NutrientEntry;
  target: Target | undefined;
  base: Target | undefined;
  hasOverride: boolean;
  energyTarget: number;
  editing: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const managed = MANAGED_ELSEWHERE.has(nutrient.code);
  const computedOnly = Boolean(nutrient.computed) && !managed;
  const editable = !managed && !computedOnly;
  const unusedCarbMode =
    !target && (nutrient.code === 'CARBS_G' || nutrient.code === 'NET_CARBS_G')
      ? nutrient.code === 'CARBS_G'
        ? 'Not used: your carb target is net carbs'
        : 'Not used: your carb target is total carbs'
      : null;
  const summary =
    nutrient.code === 'ENERGY_KCAL'
      ? `${formatInt(energyTarget)} kcal`
      : (unusedCarbMode ?? describeTarget(target, nutrient.unit));
  const note = managed
    ? 'Set in Profile & targets'
    : computedOnly
      ? 'Calculated from other nutrients'
      : null;

  const content = (
    <View style={styles.rowTop}>
      <View style={styles.flex}>
        <AppText variant="body" style={styles.bold}>{nutrient.name}</AppText>
        <AppText variant="small" muted>{summary}</AppText>
        {note ? <AppText variant="small" muted>{note}</AppText> : null}
      </View>
      {target ? <Badge label={KIND_LABEL[target.kind]} tone={target.kind === 'CUSTOM' ? 'primary' : 'neutral'} /> : null}
      {editable ? (
        <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>{editing ? 'Close' : 'Edit'}</AppText>
      ) : null}
    </View>
  );

  return (
    <View>
      {editable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${nutrient.name}, ${summary}. ${editing ? 'Close editor' : 'Edit target'}`}
          accessibilityState={{ expanded: editing }}
          onPress={onToggle}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}>
          {content}
        </Pressable>
      ) : managed && nutrient.code !== 'ENERGY_KCAL' ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${nutrient.name}, ${summary}. Opens Profile and targets`}
          onPress={() => router.push('/settings/targets')}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}>
          {content}
        </Pressable>
      ) : (
        <View style={styles.row} accessible accessibilityLabel={`${nutrient.name}, ${summary}`}>{content}</View>
      )}
      {editing ? (
        <OverrideEditor
          key={nutrient.code}
          nutrient={nutrient}
          current={target}
          base={base}
          hasOverride={hasOverride}
          onDone={onToggle}
        />
      ) : null}
    </View>
  );
}

function NutrientList({ data, overrides }: { data: ResolvedTargets; overrides: NutrientOverrides }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<NutrientCode | null>(null);

  const defaults: Targets = selectTargets({
    sex: data.profile.sex ?? 'male',
    age: data.age,
    pregnant: data.profile.pregnant,
    lactating: data.profile.lactating,
    weightKg: data.weightKg,
    energyKcal: data.energy.target,
  });

  const q = query.trim().toLowerCase();
  const matches = (n: NutrientEntry) =>
    q === '' ||
    n.name.toLowerCase().includes(q) ||
    (n.shortName ?? '').toLowerCase().includes(q) ||
    n.code.toLowerCase().includes(q.replace(/\s+/g, '_'));

  const groups = [...NUTRIENT_GROUPS]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({ group, items: nutrientsInGroup(group.code).filter(matches) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <Card>
        <TextField
          label="Search nutrients"
          value={query}
          onChangeText={setQuery}
          placeholder="e.g. magnesium"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <AppText variant="small" muted>
          RDA and AI are intake guidelines, CDRR is the sodium limit, EST are limits estimated from your energy
          target. CUSTOM means you changed it. Tap a nutrient to set your own minimum or maximum.
        </AppText>
      </Card>

      {groups.length === 0 ? (
        <Card><AppText muted>{`No nutrient matches "${query.trim()}".`}</AppText></Card>
      ) : null}

      {groups.map(({ group, items }) => (
        <Card key={group.code}>
          <AppText variant="heading" accessibilityRole="header">{group.label}</AppText>
          {items.map((nutrient, i) => (
            <View key={nutrient.code}>
              {i > 0 ? <Divider /> : null}
              <NutrientRow
                nutrient={nutrient}
                target={data.nutrients[nutrient.code]}
                base={defaults[nutrient.code]}
                hasOverride={overrides[nutrient.code] !== undefined}
                energyTarget={data.energy.target}
                editing={editing === nutrient.code}
                onToggle={() => setEditing((cur) => (cur === nutrient.code ? null : nutrient.code))}
              />
            </View>
          ))}
        </Card>
      ))}
    </>
  );
}

export default function NutrientTargetsScreen() {
  const { colors } = useTheme();
  const targets = useTargets();
  const overridesQ = useNutrientOverrides();
  const loading = targets.isLoading || overridesQ.isLoading;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Nutrient targets' }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading nutrient targets" />
        </View>
      ) : targets.data ? (
        <NutrientList data={targets.data} overrides={overridesQ.data ?? {}} />
      ) : (
        <Card>
          <AppText variant="heading">Finish setting up</AppText>
          <AppText muted>Nutrient targets depend on your age, sex and energy target.</AppText>
          <Button label="Set up targets" onPress={() => router.push('/onboarding')} />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  flex: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
  row: { minHeight: 52, paddingVertical: spacing.sm, justifyContent: 'center' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  editor: { gap: spacing.md, paddingBottom: spacing.md },
  editorFields: { flexDirection: 'row', gap: spacing.md },
  editorButtons: { flexDirection: 'row', gap: spacing.sm },
});
