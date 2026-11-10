import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { useAiStore } from '@/ai/ai-store';
import { prepareMealImage } from '@/ai/image';
import { runPhotoPipeline, STAGE_LABEL, type MealResult } from '@/ai/meal-pipeline';
import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiClient } from '@/ai/use-ai-client';
import { useAiGate } from '@/ai/use-ai-gate';
import { useAiRun } from '@/ai/use-ai-run';
import { Notice } from '@/components/ai/AiBits';
import { AiErrorPanel, AiNotAvailable, AiWorking, openAiSettings } from '@/components/ai/AiPanels';
import { MealReview } from '@/components/ai/MealReview';
import { TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

export default function PhotoLogScreen() {
  useAiBootstrap();
  const gate = useAiGate();
  const handle = useAiClient();
  const modelName = useAiStore((s) => s.models.find((m) => m.id === s.selectedModelId)?.name);
  const { colors } = useTheme();

  const [uri, setUri] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const run = useAiRun<MealResult>();

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

  function analyse() {
    if (!handle || !uri) return;
    const photoUri = uri;
    const trimmed = note.trim();
    void run.run(async ({ signal, setLabel }) => {
      setLabel('Resizing the photo on your device...');
      // The resized image lives only inside this call; it is never stored or uploaded to our backend.
      const image = await prepareMealImage(photoUri);
      const result = await runPhotoPipeline({
        handle,
        image,
        note: trimmed || undefined,
        signal,
        onStage: (stage) => setLabel(STAGE_LABEL[stage]),
      });
      setUri(null);
      return result;
    });
  }

  function startOver() {
    run.reset();
    setUri(null);
    setNote('');
    setRunId((n) => n + 1);
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Photo log' }} />

      {!gate.enabled || !handle ? (
        <AiNotAvailable reason={gate.reason} />
      ) : run.stage === 'working' ? (
        <AiWorking label={run.label || 'Working...'} onCancel={run.cancel} />
      ) : run.stage === 'done' && run.result ? (
        <MealReview
          key={runId}
          initialItems={run.result.items}
          source="ai_photo"
          notes={run.result.meal.notes}
          estimateFailed={run.result.estimateFailed}
          onStartOver={startOver}
        />
      ) : (
        <>
          {run.stage === 'error' && run.error ? (
            <AiErrorPanel
              error={run.error}
              onRetry={uri ? analyse : undefined}
              secondary={{ label: 'Choose another photo', onPress: () => { run.reset(); setUri(null); } }}
            />
          ) : null}

          <Card>
            <AppText variant="heading">Photograph your meal</AppText>
            <AppText muted>
              The AI recognises the foods and estimates amounts. Calories and nutrients then come from the food
              database, and you review everything before it is added.
            </AppText>
            {uri ? (
              <Image
                source={{ uri }}
                style={[styles.preview, { backgroundColor: colors.surfaceAlt }]}
                contentFit="cover"
                accessibilityLabel="Selected meal photo"
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
          </Card>

          {uri ? (
            <Card>
              <TextField
                label="Note for the AI (optional)"
                value={note}
                onChangeText={setNote}
                placeholder="e.g. homemade, about 2 portions"
                multiline
                maxLength={400}
                hint="Anything the photo does not show: cooking method, portions, ingredients."
                style={styles.noteInput}
              />
              <Button label="Analyse photo" onPress={analyse} />
            </Card>
          ) : null}

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
  preview: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md },
  noteInput: { minHeight: 72, paddingTop: spacing.sm, textAlignVertical: 'top' },
});
