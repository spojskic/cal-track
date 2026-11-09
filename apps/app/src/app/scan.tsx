import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Stack, router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { hapticSelection, hapticSuccess } from '@/components/food/feedback';
import { firstParam } from '@/components/food/format';
import { TextField } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import {
  expandUpcE,
  gtinDigits,
  lookupBarcode,
  validateBarcode,
  type BarcodeLookupResult,
} from '@/data/foods';
import { MAX_CONTENT_WIDTH, radius, spacing, useTheme } from '@/theme';

type ScanResult = BarcodeLookupResult | { status: 'looking'; code: string };

const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e'] as const;

export default function ScanScreen() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ mealGroupId?: string }>();
  const mealGroupId = firstParam(params.mealGroupId);
  const focused = useIsFocused();

  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [webCameraOk, setWebCameraOk] = useState<boolean | null>(Platform.OS === 'web' ? null : true);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [misread, setMisread] = useState(false);
  // Synchronous guard: onBarcodeScanned fires many times per second for one code.
  const lockRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    if (insecure) {
      setWebCameraOk(false);
      return;
    }
    CameraView.isAvailableAsync()
      .then((ok) => {
        if (!cancelled) setWebCameraOk(ok);
      })
      .catch(() => {
        if (!cancelled) setWebCameraOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Coming back from a food/new screen (or any other) re-arms the scanner.
  useEffect(() => {
    if (focused) {
      lockRef.current = false;
      setResult(null);
    }
  }, [focused]);

  async function runLookup(gtin14: string, display: string) {
    setResult({ status: 'looking', code: display });
    const res = await lookupBarcode(gtin14);
    if (res.status === 'found') {
      hapticSuccess();
      setResult(res);
      router.push({
        pathname: '/food/[id]',
        params: {
          id: res.foodId,
          source: 'barcode',
          ...(mealGroupId ? { mealGroupId } : {}),
        },
      });
      return;
    }
    setResult(res);
  }

  function onScanned(e: BarcodeScanningResult) {
    if (lockRef.current) return;
    lockRef.current = true;
    hapticSelection();
    const raw = e.type === 'upc_e' ? (expandUpcE(e.data) ?? e.data) : e.data;
    const check = validateBarcode(raw);
    if (!check.ok) {
      // A bad check digit is almost always a misread frame: keep scanning instead of locking.
      lockRef.current = false;
      setMisread(true);
      return;
    }
    setMisread(false);
    void runLookup(check.gtin14, gtinDigits(e.data));
  }

  function onManualLookup() {
    const check = validateBarcode(manual);
    if (!check.ok) {
      setManualError(check.message);
      return;
    }
    if (lockRef.current && result?.status === 'looking') return;
    setManualError(null);
    lockRef.current = true;
    void runLookup(check.gtin14, gtinDigits(manual));
  }

  function rescan() {
    lockRef.current = false;
    setMisread(false);
    setResult(null);
  }

  const locked = result !== null;
  const cameraGranted = permission?.granted === true;
  const showCamera =
    focused && cameraGranted && webCameraOk === true && cameraError === null;
  const cameraHeight = width >= 760 ? 380 : 300;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Scan barcode' }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View
            style={[
              styles.camera,
              { height: cameraHeight, backgroundColor: colors.sidebar, borderColor: colors.border },
            ]}>
            {showCamera ? (
              <>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  enableTorch={torch}
                  barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
                  onBarcodeScanned={locked ? undefined : onScanned}
                  onMountError={(e) => setCameraError(e.message || 'The camera could not start.')}
                />
                <View pointerEvents="none" style={styles.frameWrap}>
                  <View style={[styles.frame, { borderColor: colors.onPrimary }]} />
                </View>
                <View pointerEvents="none" style={styles.hintWrap}>
                  <Text style={[styles.hint, { color: colors.onPrimary, backgroundColor: `${colors.sidebar}CC` }]}>
                    {locked
                      ? 'Barcode captured'
                      : misread
                        ? 'Could not read it. Hold steady or enter the digits'
                        : 'Point the camera at a barcode'}
                  </Text>
                </View>
                {Platform.OS !== 'web' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
                    accessibilityState={{ selected: torch }}
                    onPress={() => setTorch((t) => !t)}
                    style={[
                      styles.torch,
                      { backgroundColor: torch ? colors.primary : `${colors.sidebar}CC` },
                    ]}>
                    <Text style={[styles.torchText, { color: colors.onPrimary }]}>
                      {torch ? 'Torch on' : 'Torch'}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <CameraPlaceholder
                permissionLoaded={permission !== null}
                granted={cameraGranted}
                canAskAgain={permission?.canAskAgain ?? true}
                webCameraOk={webCameraOk}
                cameraError={cameraError}
                focused={focused}
                onRequest={() => void requestPermission()}
                onRetry={() => setCameraError(null)}
              />
            )}
          </View>

          <Card>
            <AppText variant="heading">Enter barcode</AppText>
            <AppText variant="small" muted>
              Type the digits under the barcode if scanning does not work.
            </AppText>
            <TextField
              label="Barcode"
              value={manual}
              onChangeText={(t) => {
                setManual(t);
                setManualError(null);
              }}
              placeholder="e.g. 3017620422003"
              keyboardType="number-pad"
              inputMode="numeric"
              returnKeyType="search"
              onSubmitEditing={onManualLookup}
              maxLength={20}
              accessibilityLabel="Barcode digits"
              error={manualError}
            />
            <Button
              label="Look up"
              onPress={onManualLookup}
              disabled={manual.trim() === '' || result?.status === 'looking'}
            />
          </Card>

          {result ? (
            <ResultCard result={result} mealGroupId={mealGroupId} onRescan={rescan} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function CameraPlaceholder({
  permissionLoaded,
  granted,
  canAskAgain,
  webCameraOk,
  cameraError,
  focused,
  onRequest,
  onRetry,
}: {
  permissionLoaded: boolean;
  granted: boolean;
  canAskAgain: boolean;
  webCameraOk: boolean | null;
  cameraError: string | null;
  focused: boolean;
  onRequest: () => void;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  const onDark = colors.onSidebar;

  let title: string;
  let body: string;
  let action: { label: string; onPress: () => void } | null = null;

  if (!permissionLoaded || webCameraOk === null || !focused) {
    return (
      <View style={styles.placeholder}>
        <ActivityIndicator color={onDark} accessibilityLabel="Starting camera" />
      </View>
    );
  }
  if (webCameraOk === false) {
    title = 'Camera not available';
    body =
      'This browser or device has no usable camera (browsers also need HTTPS). Enter the barcode digits below instead.';
  } else if (cameraError !== null) {
    title = 'Camera could not start';
    body = `${cameraError} You can still enter the barcode digits below.`;
    action = { label: 'Try again', onPress: onRetry };
  } else if (!granted && canAskAgain) {
    title = 'Camera access needed';
    body = 'Allow camera access to scan barcodes. Photos are not saved.';
    action = { label: 'Allow camera', onPress: onRequest };
  } else {
    title = 'Camera access is blocked';
    body = 'Enable camera access for Cal Track in your device settings, or enter the barcode digits below.';
    if (Platform.OS !== 'web') action = { label: 'Open settings', onPress: () => void Linking.openSettings() };
  }

  return (
    <View style={styles.placeholder}>
      <Text style={[styles.placeholderTitle, { color: onDark }]}>{title}</Text>
      <Text style={[styles.placeholderBody, { color: colors.onSidebarMuted }]}>{body}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          style={[styles.placeholderButton, { backgroundColor: colors.primary }]}>
          <Text style={[styles.placeholderButtonText, { color: colors.onPrimary }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ResultCard({
  result,
  mealGroupId,
  onRescan,
}: {
  result: ScanResult;
  mealGroupId: string | undefined;
  onRescan: () => void;
}) {
  const { colors } = useTheme();
  const withMeal = mealGroupId ? { mealGroupId } : {};

  const goSearch = () => router.push({ pathname: '/search', params: withMeal });
  const goCreate = (gtin14: string) =>
    router.push({ pathname: '/food/new', params: { gtin: gtin14, ...withMeal } });

  switch (result.status) {
    case 'looking':
      return (
        <Card>
          <View style={styles.inline}>
            <ActivityIndicator color={colors.primary} />
            <AppText accessibilityLiveRegion="polite">Looking up {result.code}...</AppText>
          </View>
        </Card>
      );
    case 'found':
      return (
        <Card>
          <AppText accessibilityLiveRegion="polite">Opening product...</AppText>
          <Button label="Scan another" variant="secondary" onPress={onRescan} />
        </Card>
      );
    case 'notFound':
      return (
        <Card>
          <AppText variant="heading">Product not found</AppText>
          <AppText muted accessibilityLiveRegion="polite">
            No food with barcode {result.gtin14.replace(/^0+/, '')} in the food database or Open Food Facts.
          </AppText>
          <Button label="Create custom food with this barcode" onPress={() => goCreate(result.gtin14)} />
          <Button label="Search by name" variant="secondary" onPress={goSearch} />
          <Button label="Scan again" variant="ghost" onPress={onRescan} />
        </Card>
      );
    case 'rateLimited':
      return (
        <Card>
          <AppText variant="heading">Too many lookups</AppText>
          <AppText muted accessibilityLiveRegion="polite">
            {result.retryAfterSeconds !== undefined
              ? `Try again in about ${Math.ceil(result.retryAfterSeconds)} seconds. `
              : 'Wait a moment and try again. '}
            You can search by name or create the food yourself in the meantime.
          </AppText>
          <Button label="Search by name" onPress={goSearch} />
          <Button label="Create custom food" variant="secondary" onPress={() => goCreate(result.gtin14)} />
          <Button label="Try again" variant="ghost" onPress={onRescan} />
        </Card>
      );
    case 'unavailable':
      return (
        <Card>
          <AppText variant="heading">Barcode lookup unavailable</AppText>
          <AppText muted accessibilityLiveRegion="polite">
            {result.message} Barcodes already saved in your database still work.
          </AppText>
          <Button label="Search by name" onPress={goSearch} />
          <Button label="Create custom food" variant="secondary" onPress={() => goCreate(result.gtin14)} />
          <Button label="Try again" variant="ghost" onPress={onRescan} />
        </Card>
      );
    case 'invalid':
      return (
        <Card>
          <AppText variant="heading">Barcode not recognised</AppText>
          <AppText muted accessibilityLiveRegion="polite">{result.message}</AppText>
          <Button label="Scan again" onPress={onRescan} />
        </Card>
      );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  camera: {
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  frameWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: '78%', height: '44%', borderWidth: 2, borderRadius: radius.md },
  hintWrap: { position: 'absolute', left: 0, right: 0, bottom: spacing.lg, alignItems: 'center' },
  hint: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  torch: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  torchText: { fontSize: 13, fontWeight: '700' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  placeholderTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  placeholderBody: { fontSize: 14, textAlign: 'center', maxWidth: 420 },
  placeholderButton: {
    minHeight: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderButtonText: { fontSize: 15, fontWeight: '700' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
