import { pickDefaultVisionModel } from '@ration/ai';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAiStore } from '@/ai/ai-store';
import { formatContext, formatModelPrice } from '@/ai/format';
import { filterModels, sortModelsForPicker } from '@/ai/model-selection';
import { AppText, Button, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { Notice, Pill } from './AiBits';

const PAGE = 25;

/** Searchable list of image-capable OpenRouter models with context, price and capability badges. */
export function ModelPicker() {
  const { colors, radius, shape } = useTheme();
  const models = useAiStore((s) => s.models);
  const selectedId = useAiStore((s) => s.selectedModelId);
  const busy = useAiStore((s) => s.modelsBusy);
  const error = useAiStore((s) => s.modelsError);
  const notice = useAiStore((s) => s.modelNotice);
  const selectModel = useAiStore((s) => s.selectModel);
  const refreshModels = useAiStore((s) => s.refreshModels);

  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const recommendedId = useMemo(() => pickDefaultVisionModel(models)?.id ?? null, [models]);
  const selected = models.find((m) => m.id === selectedId) ?? null;
  const visible = useMemo(
    () => sortModelsForPicker(filterModels(models, query), selectedId, recommendedId),
    [models, query, selectedId, recommendedId],
  );

  return (
    <Card>
      <AppText variant="heading" accessibilityRole="header">Model</AppText>
      <AppText muted>
        Photo log needs a model that can see images. The recommended one is a good balance of price and accuracy.
      </AppText>

      {selected ? (
        <View accessible accessibilityLabel={`Selected model: ${selected.name}`}>
          <AppText variant="label" muted>Selected</AppText>
          <AppText style={styles.bold}>{selected.name}</AppText>
          <AppText variant="small" muted>{selected.id}</AppText>
        </View>
      ) : models.length > 0 ? (
        <Notice tone="warning">No model is selected. Choose one below.</Notice>
      ) : null}
      {selected && !selected.supportsStructuredOutputs ? (
        <Notice tone="warning">
          This model does not advertise structured output support, so results may fail more often. Consider a model with the
          &quot;Structured outputs&quot; badge.
        </Notice>
      ) : null}
      {notice ? <Notice tone="warning">{notice}</Notice> : null}
      {error ? <Notice tone="danger" live>{error}</Notice> : null}

      <View style={[styles.searchBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.pill }]}>
        <TextInput
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setLimit(PAGE);
          }}
          placeholder="Search models, e.g. gemini or gpt"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Search models"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: colors.text }]}
        />
      </View>
      <Button
        label={busy ? 'Refreshing...' : 'Refresh list'}
        variant="secondary"
        loading={busy}
        onPress={() => void refreshModels({ force: true })}
      />

      {models.length === 0 && !busy ? (
        <AppText muted>No models loaded yet. Tap Refresh list.</AppText>
      ) : visible.length === 0 ? (
        <AppText muted>No models match &quot;{query}&quot;.</AppText>
      ) : (
        <View style={styles.list} accessibilityRole="radiogroup">
          {visible.slice(0, limit).map((m) => {
            const isSelected = m.id === selectedId;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${m.name}. ${formatContext(m.contextLength)} context. ${formatModelPrice(m)}.${
                  m.supportsStructuredOutputs ? ' Supports structured outputs.' : ''
                }${m.id === recommendedId ? ' Recommended.' : ''}`}
                onPress={() => selectModel(m.id)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: isSelected ? `${colors.primary}1A` : colors.surface,
                    borderColor: isSelected ? colors.primary : colors.border,
                    borderRadius: radius.md,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}>
                {/* a radio button stays a circle in both looks */}
                <View style={[styles.radio, { borderColor: isSelected ? colors.primary : colors.textMuted, borderRadius: shape.dot(RADIO_SIZE) }]}>
                  {isSelected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>{m.name}</Text>
                  <AppText variant="small" muted numberOfLines={1}>{m.id}</AppText>
                  <AppText variant="small" muted>
                    {formatContext(m.contextLength)} context {'\u00B7'} {formatModelPrice(m)}
                  </AppText>
                  <View style={styles.pills}>
                    {m.id === recommendedId ? <Pill label="Recommended" tone="primary" /> : null}
                    {m.supportsStructuredOutputs ? <Pill label="Structured outputs" tone="success" /> : null}
                    {m.isFree ? <Pill label="Free" /> : null}
                  </View>
                </View>
              </Pressable>
            );
          })}
          {visible.length > limit ? (
            <Button
              label={`Show more (${visible.length - limit} more)`}
              variant="ghost"
              onPress={() => setLimit((n) => n + PAGE)}
            />
          ) : null}
        </View>
      )}
    </Card>
  );
}

const RADIO_SIZE = 20;

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
  searchBox: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  input: { fontSize: 16, minHeight: 42 },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  name: { fontSize: 15, fontWeight: '700' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  radio: {
    width: RADIO_SIZE,
    height: RADIO_SIZE,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
