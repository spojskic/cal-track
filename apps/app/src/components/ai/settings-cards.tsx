import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { useAiStore } from '@/ai/ai-store';
import { formatUsd } from '@/ai/format';
import { useCoachRetention } from '@/ai/use-coach-retention';
import { SwitchRow, TextField } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { Notice, Pill } from './AiBits';

export const KEYS_URL = 'https://openrouter.ai/keys';

/** Opens a link: in-app browser on native, a new tab on web. */
export async function openExternal(url: string): Promise<void> {
  try {
    if (Platform.OS === 'web') await Linking.openURL(url);
    else await WebBrowser.openBrowserAsync(url);
  } catch {
    // nothing sensible to do; the URL is shown in the text anyway
  }
}

/** Two-step button for destructive actions (Alert.alert does not work on web). */
function ConfirmButton({
  label,
  confirmLabel,
  question,
  onConfirm,
  loading,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  question: string;
  onConfirm: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <Button label={label} variant="secondary" onPress={() => setAsking(true)} disabled={disabled} loading={loading} />;
  }
  return (
    <View style={styles.confirm} accessibilityRole="alert">
      <AppText variant="small">{question}</AppText>
      <Button
        label={confirmLabel}
        onPress={() => {
          setAsking(false);
          onConfirm();
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => setAsking(false)} />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------------------

export function ConnectionStatusCard() {
  const { colors } = useTheme();
  const apiKey = useAiStore((s) => s.apiKey);
  const keyStatus = useAiStore((s) => s.keyStatus);
  const keyInfo = useAiStore((s) => s.keyInfo);
  const validating = useAiStore((s) => s.validating);
  const loaded = useAiStore((s) => s.loaded);
  const validationError = useAiStore((s) => s.validationError);
  const revalidate = useAiStore((s) => s.revalidate);

  let label: string;
  let tint: string;
  if (!loaded || (apiKey && validating && keyStatus === 'unknown')) {
    label = 'Checking...';
    tint = colors.textMuted;
  } else if (!apiKey) {
    label = 'Not connected';
    tint = colors.textMuted;
  } else if (keyStatus === 'valid') {
    label = 'Connected';
    tint = colors.success;
  } else if (keyStatus === 'invalid') {
    label = 'Key invalid';
    tint = colors.danger;
  } else {
    label = 'Could not verify';
    tint = colors.warning;
  }

  const limit = keyInfo?.limit ?? null;
  const remaining = keyInfo?.limitRemaining ?? null;

  return (
    <Card>
      <View style={styles.statusRow}>
        <AppText variant="heading" accessibilityRole="header" style={styles.flex}>OpenRouter</AppText>
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={`Status: ${label}`}
          style={[styles.statusPill, { backgroundColor: `${tint}22`, borderColor: `${tint}88` }]}>
          <Text style={[styles.statusText, { color: tint }]}>{label}</Text>
        </View>
      </View>

      {!apiKey ? (
        <AppText muted>
          AI is optional. Connect your own OpenRouter key to log meals from photos or text and to draft recipes. Without a
          key, Cal Track works exactly the same and shows no AI features.
        </AppText>
      ) : keyStatus === 'valid' && keyInfo ? (
        <View style={styles.facts}>
          {keyInfo.label ? <Fact label="Key" value={keyInfo.label} /> : null}
          <Fact label="Spent so far" value={formatUsd(keyInfo.usage)} />
          <Fact
            label="Credit left"
            value={remaining !== null ? `${formatUsd(remaining)}${limit !== null ? ` of ${formatUsd(limit)}` : ''}` : 'No spending limit'}
          />
          {keyInfo.isFreeTier ? <Pill label="Free tier" /> : null}
          {limit === null ? (
            <Notice tone="warning">
              This key has no spending limit. In your OpenRouter settings you can set one so usage can never run away.
            </Notice>
          ) : null}
        </View>
      ) : keyStatus === 'invalid' ? (
        <Notice tone="danger" live>
          {validationError ?? 'OpenRouter rejected the saved key.'} Connect again below, or disconnect to remove it from
          this device.
        </Notice>
      ) : apiKey ? (
        <View style={styles.facts}>
          <Notice tone="warning" live>
            {validationError ?? 'Could not reach OpenRouter to check your key.'} AI features stay hidden until the key is
            verified. Your key is still saved on this device.
          </Notice>
          <Button label="Try again" onPress={() => void revalidate()} loading={validating} />
        </View>
      ) : null}

      {keyStatus === 'valid' ? (
        <Button label="Refresh usage" variant="ghost" onPress={() => void revalidate()} loading={validating} />
      ) : null}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" muted>{label}</AppText>
      <AppText variant="body" style={styles.bold}>{value}</AppText>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------------------------------------------

/** True when the web dev server runs on a host/port OpenRouter probably rejects as a callback. */
function webCallbackMayBeRejected(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const { hostname, port, protocol } = window.location;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  return isLocal && port !== '' && port !== '443' && port !== '3000' && protocol !== 'https:';
}

export function ConnectCard() {
  const connected = useAiStore((s) => s.apiKey !== null && s.keyStatus === 'valid');
  const busy = useAiStore((s) => s.busy);
  const error = useAiStore((s) => s.error);
  const awaitingCode = useAiStore((s) => s.oauthAwaitingCode);
  const remember = useAiStore((s) => s.rememberOnDevice);
  const startOAuth = useAiStore((s) => s.startOAuth);
  const finishOAuth = useAiStore((s) => s.finishOAuth);
  const cancelOAuth = useAiStore((s) => s.cancelOAuth);
  const connectWithKey = useAiStore((s) => s.connectWithKey);
  const setRemember = useAiStore((s) => s.setRememberOnDevice);

  const [open, setOpen] = useState(false);
  const [pasteKey, setPasteKey] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [codeText, setCodeText] = useState('');
  const isWeb = Platform.OS === 'web';

  if (connected && !open) {
    return (
      <Card>
        <AppText variant="heading" accessibilityRole="header">Connection</AppText>
        {isWeb ? (
          <SwitchRow
            label="Remember on this device"
            description="Off: the key is kept only in memory and is gone when you close or reload this tab."
            value={remember}
            onChange={(v) => void setRemember(v)}
          />
        ) : null}
        <Button label="Replace key" variant="secondary" onPress={() => setOpen(true)} />
      </Card>
    );
  }

  return (
    <Card>
      <AppText variant="heading" accessibilityRole="header">{connected ? 'Replace key' : 'Connect'}</AppText>
      <AppText muted>
        Cal Track never has its own AI key. You connect your own OpenRouter account, and requests go straight from this
        device to OpenRouter.
      </AppText>

      <Button label={awaitingCode ? 'Open OpenRouter again' : 'Connect with OpenRouter'} onPress={() => void startOAuth()} loading={busy && !pasteKey && !awaitingCode} disabled={busy} />
      {isWeb && webCallbackMayBeRejected() ? (
        <Notice>
          Running locally? OpenRouter may reject this address as a sign-in callback. Serve the web app on port 3000, or
          paste an API key instead.
        </Notice>
      ) : null}

      {awaitingCode ? (
        <View style={styles.panel}>
          <Notice>
            1. Sign in to OpenRouter in the browser window and allow Cal Track. 2. Copy the code it shows. 3. Come back
            here and paste it below.
          </Notice>
          <TextField
            label="Code from OpenRouter"
            value={codeText}
            onChangeText={setCodeText}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste the code"
          />
          <Button
            label="Finish connecting"
            loading={busy}
            disabled={codeText.trim() === ''}
            onPress={async () => {
              const res = await finishOAuth({ kind: 'pasted', text: codeText });
              if (res.ok) {
                setCodeText('');
                setOpen(false);
              }
            }}
          />
          <Button label="Cancel" variant="ghost" onPress={() => { cancelOAuth(); setCodeText(''); }} />
        </View>
      ) : null}

      <View style={styles.panel}>
        {pasteKey ? (
          <>
            <TextField
              label="OpenRouter API key"
              value={keyText}
              onChangeText={setKeyText}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              placeholder="sk-or-v1-..."
              hint="Stored only on this device. It is checked with OpenRouter before it is saved."
            />
            <Button
              label="Connect with this key"
              loading={busy && pasteKey}
              disabled={busy || keyText.trim() === ''}
              onPress={async () => {
                const res = await connectWithKey(keyText);
                if (res.ok) {
                  setKeyText('');
                  setPasteKey(false);
                  setOpen(false);
                }
              }}
            />
            <Pressable accessibilityRole="link" onPress={() => void openExternal(KEYS_URL)} hitSlop={6}>
              <LinkText>Create a key at openrouter.ai/keys</LinkText>
            </Pressable>
            <Notice>
              Tip: create a key with a credit limit (for example $5). Then even a leaked key cannot cost more than that,
              and you can revoke it any time at openrouter.ai/keys.
            </Notice>
          </>
        ) : (
          <Button label="Paste an API key instead" variant="secondary" onPress={() => setPasteKey(true)} disabled={busy} />
        )}
      </View>

      {isWeb ? (
        <SwitchRow
          label="Remember on this device"
          description="Off: the key is kept only in memory and is gone when you close or reload this tab."
          value={remember}
          onChange={(v) => void setRemember(v)}
        />
      ) : null}

      {error ? <Notice tone="danger" live>{error}</Notice> : null}
      {connected ? <Button label="Cancel" variant="ghost" onPress={() => { setOpen(false); setPasteKey(false); }} /> : null}
    </Card>
  );
}

function LinkText({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.link, { color: colors.accent }]}>{children}</Text>;
}

// ---------------------------------------------------------------------------------------------------------------
// Privacy + disconnect
// ---------------------------------------------------------------------------------------------------------------

export function PrivacyCard() {
  const apiKey = useAiStore((s) => s.apiKey);
  const busy = useAiStore((s) => s.busy);
  const disconnect = useAiStore((s) => s.disconnect);
  const storage = Platform.OS === 'web' ? 'encrypted browser storage on this device' : 'the secure Keychain / Keystore of this device';

  return (
    <Card>
      <AppText variant="heading" accessibilityRole="header">Privacy</AppText>
      <AppText>
        What is sent: when you use Photo log, Describe a meal or recipe drafts, the photo or text you submit (and, for the
        upcoming AI Coach, a short summary of your targets and diary) goes directly from this device to OpenRouter and the
        model provider you selected. Cal Track does not receive it. Photos are resized on your device and are never
        uploaded to Cal Track.
      </AppText>
      <AppText>
        Your key: stored only in {storage}. It is never sent to Cal Track&apos;s servers, logged, or synced to other devices.
        If you sign out of Cal Track the key stays on this device until you disconnect it here.
      </AppText>
      <AppText variant="small" muted>
        Foods the AI estimates are saved as &quot;AI estimate&quot; foods in your own list. They are never presented as verified data.
      </AppText>
      {apiKey ? (
        <ConfirmButton
          label="Disconnect and remove key from this device"
          confirmLabel="Yes, remove the key"
          question="This deletes the key from this device and hides all AI features. Your OpenRouter account is not affected. You can connect again at any time."
          loading={busy}
          disabled={busy}
          onConfirm={() => void disconnect()}
        />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Coach chat retention
// ---------------------------------------------------------------------------------------------------------------

export function CoachRetentionCard() {
  const retention = useCoachRetention();
  const [doneCount, setDoneCount] = useState<number | null>(null);

  return (
    <Card>
      <AppText variant="heading" accessibilityRole="header">Coach chats</AppText>
      <AppText muted>
        AI Coach conversations are stored in your Cal Track account so they sync between devices. Only the chat text is
        stored; your OpenRouter key never is.
      </AppText>
      <SwitchRow
        label="Auto-delete coach chats older than 3 months"
        description="On by default. Older messages are removed automatically."
        value={retention.autoDelete}
        onChange={(v) => retention.setAutoDelete.mutate(v)}
      />
      {retention.setAutoDelete.error ? (
        <Notice tone="danger" live>Could not save this setting. Try again.</Notice>
      ) : null}
      <ConfirmButton
        label="Delete all coach chats now"
        confirmLabel="Yes, delete all coach chats"
        question="This permanently deletes every coach conversation in your account. It cannot be undone."
        loading={retention.deleteAll.isPending}
        disabled={retention.deleteAll.isPending}
        onConfirm={() =>
          retention.deleteAll.mutate(undefined, {
            onSuccess: (n) => setDoneCount(n),
            onError: () => setDoneCount(null),
          })
        }
      />
      {retention.deleteAll.isError ? (
        <Notice tone="danger" live>Could not delete the chats. Check your connection and try again.</Notice>
      ) : doneCount !== null ? (
        <Notice tone="success" live>
          {doneCount === 0 ? 'There were no coach chats to delete.' : `Deleted ${doneCount} coach ${doneCount === 1 ? 'chat' : 'chats'}.`}
        </Notice>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusPill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 4 },
  statusText: { fontSize: 13, fontWeight: '800' },
  facts: { gap: spacing.sm },
  fact: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  panel: { gap: spacing.sm },
  confirm: { gap: spacing.sm },
  link: { fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
});
