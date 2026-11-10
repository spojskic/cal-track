import type { LabelFoodDraft } from '@cal/core';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { useAiStore } from '@/ai/ai-store';
import { prepareLabelImage } from '@/ai/image';
import { LABEL_STAGE, runLabelScan } from '@/ai/label-pipeline';
import { FROM_FOOD_FORM } from '@/ai/navigation';
import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiClient } from '@/ai/use-ai-client';
import { useAiGate } from '@/ai/use-ai-gate';
import { useAiRun } from '@/ai/use-ai-run';
import { Notice } from '@/components/ai/AiBits';
import { AiErrorPanel, AiNotAvailable, AiWorking, openAiSettings } from '@/components/ai/AiPanels';
import { firstParam } from '@/components/food/format';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { setLabelDraft } from '@/state/label-draft';
import { spacing, useTheme } from '@/theme';

/**
 * Scan nutrition label: photograph (or pick) the Nutrition Facts panel, a vision model reads it through the user's own
 * OpenRouter key, and the normal New food form opens with everything it read. Nothing is saved here or there until the
 * user has checked the values and pressed Save food.
 */
export default function ScanLabelScreen() {
  useAiBootstrap();
  const gate = useAiGate();
  const handle = useAiClient();
  const modelName = useAiStore((s) => s.models.find((m) => m.id === s.selectedModelId)?.name);
  const { colors, radius } = useTheme();
  const params = useLocalSearchParams<{ gtin?: string; mealGroupId?: string; from?: string }>();
  const gtin = firstParam(params.gtin);
  const mealGroupId = firstParam(params.mealGroupId);
  const fromForm = firstParam(params.from) === FROM_FOOD_FORM;

  const [uri, setUri] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const run = useAiRun<LabelFoodDraft>();

  // Android may kill the activity while the camera is open; recover the photo it returned.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    ImagePicker.getPendingResultAsync()
      .then((res) => {
        if (res && 'assets' in res && !res.canceled && res.assets?.[0]) setUri(res.assets[0].uri);
      })
      .catch(() => undefined);
  }, []);

  async function takePhoto() {
    setPickError(null);
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setPickError(
          perm.canAskAgain
            ? 'Camera permission is needed to take a photo. You can also choose a photo from your library.'
            : 'Camera access is turned off for Cal Track. Enable it in your phone settings, or choose a photo from your library.',
        );
        return;
      }
    }
    try {
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (!res.canceled && res.assets[0]) setUri(res.assets[0].uri);
    } catch {
      setPickError('Could not open the camera. Choose a photo from your library instead.');
    }
  }

  async function chooseFromLibrary() {
    setPickError(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (!res.canceled && res.assets[0]) setUri(res.assets[0].uri);
    } catch {
      setPickError('Could not open your photos. Check that Cal Track may access them in your phone settings.');
    }
  }

  function readLabel() {
    if (!handle || !uri) return;
    const photoUri = uri;
    void run.run(async ({ signal, setLabel }) => {
      setLabel('Resizing the photo on your device...');
      // The resized image lives only inside this call; it is never stored or uploaded to our backend.
      const image = await prepareLabelImage(photoUri);
      setLabel(LABEL_STAGE);
      const { draft } = await runLabelScan({ handle, image, signal });
      if (signal.aborted) return draft;
      setUri(null);
      // Hand the draft to the New food form. Nothing is saved: the user reviews and edits it there.
      setLabelDraft(draft);
      if (fromForm && router.canGoBack()) {
        router.back();
      } else {
        router.replace({
          pathname: '/food/new',
          params: { ...(gtin ? { gtin } : {}), ...(mealGroupId ? { mealGroupId } : {}) },
        });
      }
      return draft;
    });
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Scan nutrition label' }} />

      {!gate.enabled || !handle ? (
        <AiNotAvailable reason={gate.reason} />
      ) : run.stage === 'working' ? (
        <AiWorking label={run.label || 'Working...'} onCancel={run.cancel} />
      ) : run.stage === 'done' ? (
        <Card>
          <AppText accessibilityLiveRegion="polite">Opening the food form...</AppText>
        </Card>
      ) : (
        <>
          {run.stage === 'error' && run.error ? (
            <AiErrorPanel
              error={run.error}
              onRetry={uri ? readLabel : undefined}
              secondary={{ label: 'Choose another photo', onPress: () => { run.reset(); setUri(null); } }}
            />
          ) : null}

          <Card>
            <AppText variant="heading">Photograph the nutrition label</AppText>
            <AppText muted>
              The AI reads the numbers printed on the package. They fill in a new food that you check and edit before it
              is saved. Nothing is added to your diary or foods automatically.
            </AppText>
            <AppText variant="small" muted>
              Tips: fill the frame with the Nutrition Facts table, hold the phone straight, and avoid glare and folds.
            </AppText>
            {uri ? (
              <Image
                source={{ uri }}
                style={[styles.preview, { backgroundColor: colors.surfaceAlt, borderRadius: radius.md }]}
                contentFit="cover"
                accessibilityLabel="Selected nutrition label photo"
              />
            ) : null}
            <View style={styles.row}>
              <View style={styles.flex}>
                <Button label={uri ? 'Retake photo' : 'Take a photo'} onPress={takePhoto} />
              </View>
              <View style={styles.flex}>
                <Button label="From library" variant="secondary" onPress={chooseFromLibrary} />
              </View>
            </View>
            {pickError ? (
              <Notice tone="danger" live>
                {pickError}
              </Notice>
            ) : null}
            {pickError?.includes('settings') && Platform.OS !== 'web' ? (
              <Button label="Open settings" variant="ghost" onPress={() => void Linking.openSettings()} />
            ) : null}
            {uri ? <Button label="Read label" onPress={readLabel} /> : null}
          </Card>

          <Notice>
            {`Privacy: the photo is resized on your device and sent only to OpenRouter and the model provider you chose${modelName ? ` (${modelName})` : ''}. It is not uploaded to Cal Track.`}
          </Notice>
          <Button label="AI settings and model" variant="ghost" onPress={openAiSettings} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 150 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  preview: { width: '100%', aspectRatio: 4 / 3 },
});
