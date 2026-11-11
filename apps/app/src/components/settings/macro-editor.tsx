import { tryComputeMacroTargets, type MacroTargets } from '@ration/core';
import { StyleSheet, View } from 'react-native';

import { NumberField, Segmented } from '@/components/forms';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatAmount, formatInt, formatKcal, formatPct } from './format';
import {
  draftToMode,
  switchDraftMode,
  type MacroDraft,
  type MacroEditorMode,
} from './macro-draft';
import { Note } from './rows';

type MacroKey = 'protein' | 'carbs' | 'fat';

const MODE_OPTIONS: { value: MacroEditorMode; label: string }[] = [
  { value: 'ratios', label: 'Ratios' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'keto', label: 'Keto' },
];

/** Live preview of a draft: parsed mode, resulting macros and the reason it is not valid. */
export function previewMacroDraft(
  draft: MacroDraft,
  energyKcal: number,
  body: { weightKg: number; bodyFatPct: number | null },
) {
  const parsed = draftToMode(draft);
  if (!parsed.mode) return { ...parsed, macros: null as MacroTargets | null };
  const attempt = tryComputeMacroTargets(parsed.mode, energyKcal, body);
  return {
    mode: attempt.macros ? parsed.mode : null,
    error: attempt.error,
    ratioSum: parsed.ratioSum,
    macros: attempt.macros,
  };
}

function ResultLine({ macros, which }: { macros: MacroTargets | null; which: MacroKey }) {
  const { colors } = useTheme();
  const dot = which === 'protein' ? colors.protein : which === 'carbs' ? colors.carbs : colors.fat;
  const m = macros?.[which];
  return (
    <View style={styles.resultLine}>
      <View style={[styles.swatch, { backgroundColor: dot }]} />
      <AppText variant="small" muted>
        {m ? `${formatAmount(m.grams)} g \u00B7 ${formatInt(m.kcal)} kcal \u00B7 ${formatPct(m.pct)}%` : '-'}
      </AppText>
    </View>
  );
}

/**
 * Macro target editor with the Ratios | Fixed | Keto tabs (short labels: three long ones wrapped onto two lines on a phone).
 * Fully controlled; the parent owns the draft and decides when to save
 * (use {@link previewMacroDraft} to get the parsed mode).
 */
export function MacroEditor({
  draft,
  onChange,
  energyKcal,
  weightKg,
  bodyFatPct,
  netCarbs,
}: {
  draft: MacroDraft;
  onChange: (next: MacroDraft) => void;
  energyKcal: number;
  weightKg: number;
  bodyFatPct: number | null;
  /** Label carbs as "Net Carbs". */
  netCarbs: boolean;
}) {
  const { colors } = useTheme();
  const preview = previewMacroDraft(draft, energyKcal, { weightKg, bodyFatPct });
  const macros = preview.macros;
  const carbsLabel = netCarbs || draft.mode === 'keto' ? 'Net Carbs' : 'Carbs';
  const set = (patch: Partial<MacroDraft>) => onChange({ ...draft, ...patch });

  return (
    <View style={styles.root}>
      <Segmented
        options={MODE_OPTIONS}
        value={draft.mode}
        onChange={(mode) => onChange(switchDraftMode(draft, mode, macros))}
      />

      {draft.mode === 'ratios' ? (
        <View style={styles.grid}>
          <View style={styles.cell}>
            <NumberField label="Protein" unit="%" value={draft.proteinPct} onChange={(v) => set({ proteinPct: v })} />
            <ResultLine macros={macros} which="protein" />
          </View>
          <View style={styles.cell}>
            <NumberField label={carbsLabel} unit="%" value={draft.carbsPct} onChange={(v) => set({ carbsPct: v })} />
            <ResultLine macros={macros} which="carbs" />
          </View>
          <View style={styles.cell}>
            <NumberField label="Fat" unit="%" value={draft.fatPct} onChange={(v) => set({ fatPct: v })} />
            <ResultLine macros={macros} which="fat" />
          </View>
        </View>
      ) : null}

      {draft.mode === 'fixed' ? (
        <View style={styles.grid}>
          <View style={styles.cell}>
            <NumberField label="Protein" unit="g" value={draft.proteinG} onChange={(v) => set({ proteinG: v })} />
            <ResultLine macros={macros} which="protein" />
          </View>
          <View style={styles.cell}>
            <NumberField label={carbsLabel} unit="g" value={draft.carbsG} onChange={(v) => set({ carbsG: v })} />
            <ResultLine macros={macros} which="carbs" />
          </View>
          <View style={styles.cell}>
            <NumberField label="Fat" unit="g" value={draft.fatG} onChange={(v) => set({ fatG: v })} />
            <ResultLine macros={macros} which="fat" />
          </View>
        </View>
      ) : null}

      {draft.mode === 'keto' ? (
        <View style={styles.grid}>
          <View style={styles.cell}>
            <NumberField
              label="Net carbs"
              unit="g"
              value={draft.netCarbsG}
              onChange={(v) => set({ netCarbsG: v })}
              hint="Daily cap"
            />
          </View>
          <View style={styles.cell}>
            <NumberField
              label="Protein"
              unit="g per kg lean mass"
              value={draft.proteinPerKgLean}
              onChange={(v) => set({ proteinPerKgLean: v })}
              hint="Fat fills the rest of your energy target"
            />
          </View>
        </View>
      ) : null}

      {draft.mode === 'keto' && macros ? (
        <View style={styles.grid}>
          <View style={styles.cell}><AppText variant="small" muted>Protein</AppText><ResultLine macros={macros} which="protein" /></View>
          <View style={styles.cell}><AppText variant="small" muted>Net carbs</AppText><ResultLine macros={macros} which="carbs" /></View>
          <View style={styles.cell}><AppText variant="small" muted>Fat</AppText><ResultLine macros={macros} which="fat" /></View>
        </View>
      ) : null}

      {draft.mode === 'ratios' && preview.ratioSum !== null ? (
        <View style={styles.totalRow} accessible accessibilityLabel={`Total ${formatPct(preview.ratioSum)} percent`}>
          <AppText variant="body" style={styles.bold}>Total</AppText>
          <AppText
            variant="body"
            style={[styles.bold, { color: Math.abs(preview.ratioSum - 100) <= 0.01 ? colors.success : colors.danger }]}>
            {formatPct(preview.ratioSum)}%
          </AppText>
        </View>
      ) : null}

      {draft.mode === 'fixed' && macros ? (
        <View style={styles.totalRow}>
          <AppText variant="body" style={styles.bold}>Total</AppText>
          <AppText variant="body" style={styles.bold}>
            {formatKcal(macros.macroKcal)} of {formatKcal(energyKcal)}
          </AppText>
        </View>
      ) : null}

      {preview.error ? <Note tone="danger">{preview.error}</Note> : null}
      {macros && macros.warnings.length > 0 ? <Note tone="info">{macros.warnings.join(' ')}</Note> : null}
      {draft.mode === 'fixed' && macros && Math.abs(macros.macroKcal - energyKcal) > energyKcal * 0.05 ? (
        <Note tone="warning">
          {`Your fixed targets add up to ${formatKcal(macros.macroKcal)}, which differs from your energy target of ${formatKcal(energyKcal)}.`}
        </Note>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  cell: { flex: 1, minWidth: 130, gap: spacing.xs },
  resultLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  bold: { fontWeight: '700' },
});
