import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Stack, router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AiLabelButton } from '@/components/ai';
import { closeScreen } from '@/components/activity/navigation';
import { hapticSelection, hapticSuccess } from '@/components/food/feedback';
import { firstParam } from '@/components/food/format';
import { SCAN_BARCODE_TYPES, classifyScan } from '@/components/food/scan-code';
import { TextField } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import {
  errorMessage,
  fetchFoodIdentity,
  gtinDigits,
  lookupBarcode,
  validateBarcode,
  type BarcodeLookupResult,
} from '@/data/foods';
import { fetchDefaultServing } from '@/data/recipes';
import { deliverPickedFood, hasFoodPickHandler } from '@/state/food-picker';
import { MAX_CONTENT_WIDTH, palette, radius, spacing, useTheme } from '@/theme';

type ScanResult =
  | BarcodeLookupResult
  | { status: 'looking'; code: string }
  | { status: 'pickFailed'; message: string };

/** A hint that replaces "Place barcode in the frame" for a moment (a misread, a QR code that is not a food). */
interface Notice {
  text: string;
  /** Set again for every showing, so repeating the same text restarts its timer. */
  at: number;
}

/** Longest wait for the camera state (permission, availability) before the screen falls back to typing the digits. */
const START_TIMEOUT_MS = 2500;
const NOTICE_VISIBLE_MS = 3500;
/** The camera reports the same code many times a second: say "not a food barcode" at most this often per code. */
const NOTICE_REPEAT_MS = 1500;

const SCAN_HINT = 'Place barcode in the frame to scan';

export default function ScanScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ mealGroupId?: string; mode?: string; from?: string }>();
  const mealGroupId = firstParam(params.mealGroupId);
  // /scan?mode=pick (opened from /search?mode=pick): hand the product to the screen waiting for an ingredient.
  const pickMode = firstParam(params.mode) === 'pick';
  // Opened from the search screen: "Search by name" goes back to it instead of stacking a second search screen.
  const fromSearch = firstParam(params.from) === 'search';
  const focused = useIsFocused();

  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Insecure web contexts (plain http) can never open the camera: decide that up-front instead of in an effect.
  const [webCameraOk, setWebCameraOk] = useState<boolean | null>(() => {
    if (Platform.OS !== 'web') return true;
    return typeof window !== 'undefined' && window.isSecureContext === false ? false : null;
  });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [typing, setTyping] = useState(false);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [startTimedOut, setStartTimedOut] = useState(false);
  // Synchronous guard: onBarcodeScanned fires many times per second for one code.
  const lockRef = useRef(false);
  const lastNoticeRef = useRef<{ key: string; at: number } | null>(null);
  const askedRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    if (typeof window !== 'undefined' && window.isSecureContext === false) return; // already false
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

  // The permission state can fail to load (e.g. a browser without the permissions API): never wait for it forever.
  useEffect(() => {
    const timer = setTimeout(() => setStartTimedOut(true), START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Ask for the camera as soon as the scanner opens (the system dialog), once; later the screen offers a button.
  useEffect(() => {
    if (Platform.OS === 'web' || askedRef.current) return;
    if (permission && !permission.granted && permission.canAskAgain) {
      askedRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  // Coming back from a food/new screen (or any other) re-arms the scanner.
  useFocusEffect(
    useCallback(() => {
      lockRef.current = false;
      lastNoticeRef.current = null;
      setNotice(null);
      setResult(null);
    }, []),
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Pick mode: gives the scanned product (with its default serving) to the waiting screen. false = nobody is waiting. */
  async function handOverToPicker(foodId: string): Promise<boolean> {
    const [identity, serving] = await Promise.all([fetchFoodIdentity(foodId), fetchDefaultServing(foodId)]);
    if (!identity) throw new Error('That product is not available any more.');
    const delivered = deliverPickedFood({
      id: foodId,
      name: identity.name,
      brand: identity.brand,
      grams: serving.grams,
      amount: serving.amount,
      portionLabel: serving.label,
    });
    if (!delivered) return false;
    // Leave the scanner and the search screen underneath it: back to the screen that asked for the ingredient.
    if (router.canDismiss()) router.dismiss(2);
    else router.replace('/');
    return true;
  }

  function openFood(foodId: string) {
    router.push({
      pathname: '/food/[id]',
      params: {
        id: foodId,
        source: 'barcode',
        ...(mealGroupId ? { mealGroupId } : {}),
      },
    });
  }

  async function runLookup(gtin14: string, display: string) {
    setResult({ status: 'looking', code: display });
    const res = await lookupBarcode(gtin14);
    if (res.status !== 'found') {
      setResult(res);
      return;
    }
    hapticSuccess();
    if (pickMode && hasFoodPickHandler()) {
      try {
        if (await handOverToPicker(res.foodId)) return;
      } catch (e) {
        setResult({ status: 'pickFailed', message: errorMessage(e) });
        return;
      }
    }
    setResult(res);
    openFood(res.foodId);
  }

  function onScanned(e: BarcodeScanningResult) {
    if (lockRef.current) return;
    const outcome = classifyScan(e.type, e.data);
    if (outcome.kind !== 'gtin') {
      // Not lockable (a misread frame, a QR code that is no food): keep scanning, but say it once per code.
      const key = `${e.type}:${e.data}`;
      const now = Date.now();
      const last = lastNoticeRef.current;
      if (last && last.key === key && now - last.at < NOTICE_REPEAT_MS) return;
      lastNoticeRef.current = { key, at: now };
      hapticSelection();
      setNotice({ text: outcome.notice, at: now });
      return;
    }
    lockRef.current = true;
    hapticSelection();
    setNotice(null);
    void runLookup(outcome.gtin14, outcome.display);
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
    lastNoticeRef.current = null;
    setNotice(null);
    setResult(null);
  }

  const locked = result !== null;
  const cameraGranted = permission?.granted === true;
  const showCamera = focused && cameraGranted && webCameraOk === true && cameraError === null;
  // Still finding out whether a camera can be used (or another screen is on top): a quiet dark screen instead of a
  // flash of the fallback. Without a usable web camera there is nothing to wait for.
  const waitingForCamera = webCameraOk === null || (webCameraOk && permission === null);
  const starting = !showCamera && (!focused || (!startTimedOut && waitingForCamera));

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: 'Scan Barcode',
        headerTitleAlign: 'center',
        headerTitleStyle: { color: colors.text, fontWeight: '700' },
        headerBackVisible: false,
        headerLeft: () => <CloseButton />,
      }}
    />
  );

  // The header is rendered next to the body (not inside it) so it stays mounted when the body switches.
  let body: ReactNode;
  if (typing || (!showCamera && !starting)) {
    // ---- Manual entry / no camera: a regular form screen.
    body = (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets>
          <View style={styles.content}>
            {!showCamera ? (
              <View style={[styles.placeholderBox, { backgroundColor: colors.sidebar, borderColor: colors.border }]}>
                <CameraPlaceholder
                  granted={cameraGranted}
                  canAskAgain={permission?.canAskAgain ?? true}
                  webCameraOk={webCameraOk}
                  cameraError={cameraError}
                  onRequest={() => void requestPermission()}
                  onRetry={() => setCameraError(null)}
                />
              </View>
            ) : null}

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

            {showCamera ? (
              <Button label="Scan with camera" variant="secondary" onPress={() => setTyping(false)} />
            ) : null}

            {result ? (
              <ResultCard
                result={result}
                mealGroupId={mealGroupId}
                pickMode={pickMode}
                fromSearch={fromSearch}
                onRescan={rescan}
              />
            ) : null}
          </View>
        </ScrollView>
      </View>
    );
  } else if (starting) {
    // ---- Still starting: dark stage with a spinner.
    body = (
      <View style={[styles.screen, styles.center, { backgroundColor: colors.sidebar }]}>
        <ActivityIndicator color={colors.onSidebar} accessibilityLabel="Starting camera" />
      </View>
    );
  } else {
    // ---- The scanner: full-bleed camera, hint and frame in the middle, FLASH / TYPE BARCODE at the bottom.
    const frameSize = Math.round(Math.min(Math.max(Math.min(width * 0.72, height * 0.4), 180), 320));
    const hint = locked ? 'Barcode captured' : (notice?.text ?? SCAN_HINT);
    body = (
      <View style={[styles.screen, { backgroundColor: colors.sidebar }]}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: [...SCAN_BARCODE_TYPES] }}
          onBarcodeScanned={locked ? undefined : onScanned}
          onMountError={(e) => setCameraError(e.message || 'The camera could not start.')}
        />
        <View pointerEvents="none" style={styles.overlay}>
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.hint, notice && !locked && styles.hintNotice]}>
            {hint}
          </Text>
          <View
            style={[
              styles.frame,
              { width: frameSize, height: frameSize, borderColor: locked ? palette.green : '#FFFFFF' },
            ]}
          />
        </View>
        <View style={styles.bottomStack}>
          {result ? (
            <View style={styles.resultWrap}>
              <ResultCard
                result={result}
                mealGroupId={mealGroupId}
                pickMode={pickMode}
                fromSearch={fromSearch}
                onRescan={rescan}
              />
            </View>
          ) : null}
          <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
            {Platform.OS !== 'web' ? (
              <BarButton
                label="FLASH"
                accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
                selected={torch}
                symbol={
                  torch
                    ? { ios: 'bolt.fill', android: 'flash_on', web: 'flash_on' }
                    : { ios: 'bolt.slash.fill', android: 'flash_off', web: 'flash_off' }
                }
                tint={torch ? palette.amber : '#FFFFFF'}
                onPress={() => setTorch((t) => !t)}
              />
            ) : (
              <View />
            )}
            <BarButton
              label="TYPE BARCODE"
              accessibilityLabel="Type barcode"
              symbol={{ ios: 'keyboard', android: 'keyboard', web: 'keyboard' }}
              tint="#FFFFFF"
              onPress={() => setTyping(true)}
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      {header}
      {body}
    </>
  );
}

/** The X at the left of the header: leaves the scanner. */
function CloseButton() {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close"
      onPress={closeScreen}
      hitSlop={10}
      style={styles.close}>
      <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={18} tintColor={colors.text} />
    </Pressable>
  );
}

function BarButton({
  label,
  accessibilityLabel,
  symbol,
  tint,
  selected,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  symbol: SymbolViewProps['name'];
  tint: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: selected ?? false }}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.barButton, pressed && { opacity: 0.7 }]}>
      <SymbolView name={symbol} size={22} tintColor={tint} />
      <Text style={styles.barLabel}>{label}</Text>
    </Pressable>
  );
}

function CameraPlaceholder({
  granted,
  canAskAgain,
  webCameraOk,
  cameraError,
  onRequest,
  onRetry,
}: {
  granted: boolean;
  canAskAgain: boolean;
  webCameraOk: boolean | null;
  cameraError: string | null;
  onRequest: () => void;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  const onDark = colors.onSidebar;

  let title: string;
  let body: string;
  let action: { label: string; onPress: () => void } | null = null;

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
  pickMode,
  fromSearch,
  onRescan,
}: {
  result: ScanResult;
  mealGroupId: string | undefined;
  pickMode: boolean;
  fromSearch: boolean;
  onRescan: () => void;
}) {
  const { colors } = useTheme();
  const withMeal = mealGroupId ? { mealGroupId } : {};

  // The scanner was opened from the search screen: it is still underneath, so go back to it.
  const goSearch = () => {
    if (fromSearch && router.canGoBack()) router.back();
    else router.push({ pathname: '/search', params: { ...withMeal, ...(pickMode ? { mode: 'pick' } : {}) } });
  };
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
    case 'pickFailed':
      return (
        <Card>
          <AppText variant="heading">Could not use this product</AppText>
          <AppText muted accessibilityLiveRegion="polite">{result.message}</AppText>
          <Button label="Scan again" onPress={onRescan} />
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
          {/* Renders nothing unless the AI gate is open. The barcode goes into the new food. */}
          <AiLabelButton label="Fill in from the nutrition label (AI)" gtin={result.gtin14} mealGroupId={mealGroupId} />
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
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  frame: { borderWidth: 3, borderRadius: radius.lg + 8 },
  hint: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  hintNotice: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
    textShadowRadius: 0,
  },
  bottomStack: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  resultWrap: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    paddingHorizontal: spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  barButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  barLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  placeholderBox: {
    width: '100%',
    minHeight: 220,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
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
