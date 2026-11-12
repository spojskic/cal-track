import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { ConfirmSheet } from '@/components/diary/ConfirmSheet';
import { TextField } from '@/components/forms';
import {
  DEFAULT_INVITE_FORM,
  EXPIRY_CHOICES,
  inviteDetails,
  inviteErrorMessage,
  inviteMessage,
  inviteStatusLabel,
  inviteTitle,
  pageInfo,
  parseInviteForm,
  type InviteCode,
  type InviteForm,
  type InviteFormErrors,
  type PageInfo,
} from '@/components/settings/invite-view';
import { Badge, Chip, Divider, Note } from '@/components/settings/rows';
import { PillButton } from '@/components/pill-button';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useCreateInviteCode, useInvitePage, useIsSuperAdmin, useRevokeInviteCode } from '@/data/invites';
import { copyText } from '@/lib/copy-text';
import { spacing, useTheme } from '@/theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });

/**
 * Invite people (More > Admin): the super admin creates invite codes for e-mail addresses and the person gets the code by
 * e-mail (the `send-invite` Edge Function through Resend). The screen is for profiles.is_admin only, and the database
 * refuses everybody else (supabase/migrations/20261110000107_super_admin_invites.sql). Copying the code stays as the
 * fallback for an e-mail that did not go out.
 *
 * The lists are paged (20 codes a page, newest first) by the server, so thousands of codes cost the same as a few.
 */
export default function InvitesScreen() {
  const { isAdmin, isLoading } = useIsSuperAdmin();
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Invite people' }} />
      {isLoading ? (
        <AppText muted>Loading...</AppText>
      ) : isAdmin ? (
        <InviteAdmin />
      ) : (
        <Card>
          <AppText variant="heading">Invite people</AppText>
          <AppText muted>Only the app owner can invite people.</AppText>
        </Card>
      )}
    </Screen>
  );
}

function InviteAdmin() {
  const create = useCreateInviteCode();
  const revoke = useRevokeInviteCode();
  const [form, setForm] = useState<InviteForm>({ ...DEFAULT_INVITE_FORM });
  const [errors, setErrors] = useState<InviteFormErrors>({});
  const [created, setCreated] = useState<{ code: string; email: string; sent: boolean } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<InviteCode | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [activePage, setActivePage] = useState(0);
  const [closedPage, setClosedPage] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const active = useInvitePage('active', activePage);
  const closed = useInvitePage('closed', closedPage);
  const activeInfo = pageInfo(active.data?.total ?? 0, activePage);
  const closedInfo = pageInfo(closed.data?.total ?? 0, closedPage);

  // The moment the list was fetched: the relative expiry texts are relative to it (and the render stays pure).
  const nowMs = active.dataUpdatedAt;

  const copy = (key: string, text: string) => {
    copyText(text)
      .then(() => {
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {});
  };

  const submit = () => {
    const parsed = parseInviteForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    create.mutate(parsed.value, {
      onSuccess: ({ code, sent }) => {
        setCreated({ code, email: parsed.value.email, sent });
        setForm({ ...DEFAULT_INVITE_FORM });
        setActivePage(0); // newest first: the new code is on the first page
      },
    });
  };

  return (
    <View style={styles.stack}>
      <Card>
        <AppText variant="heading">Create an invite code</AppText>
        <AppText variant="small" muted>
          The person gets an e-mail with the code. They enter it under Create account on the sign-in screen.
        </AppText>
        <TextField
          label="E-mail"
          hint="The person you are inviting. They get an e-mail with the code and the link."
          placeholder="anna@example.com"
          value={form.email}
          onChangeText={(email) => setForm({ ...form, email })}
          error={errors.email}
          keyboardType="email-address"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          maxLength={254}
        />
        <TextField
          label="Number of uses"
          hint="How many accounts the code can create. Usually 1."
          value={form.maxUses}
          onChangeText={(maxUses) => setForm({ ...form, maxUses })}
          error={errors.maxUses}
          keyboardType="number-pad"
          inputMode="numeric"
        />
        <View style={styles.field}>
          <AppText variant="label" muted>Valid for</AppText>
          <View style={styles.chips}>
            {EXPIRY_CHOICES.map((choice) => (
              <Chip
                key={choice.label}
                label={choice.label}
                selected={form.validDays === choice.days}
                onPress={() => setForm({ ...form, validDays: choice.days })}
              />
            ))}
          </View>
        </View>
        {create.error ? <Note tone="danger">{inviteErrorMessage(create.error)}</Note> : null}
        <Button label="Create code" onPress={submit} loading={create.isPending} />
      </Card>

      {created ? <CreatedCode created={created} copied={copied} onCopy={copy} onDismiss={() => setCreated(null)} /> : null}

      <Card>
        <View style={styles.headerRow}>
          <AppText variant="heading">Active codes</AppText>
          {active.data ? <Badge label={String(active.data.total)} /> : null}
        </View>
        {active.isLoading ? <AppText muted>Loading codes...</AppText> : null}
        {active.error ? (
          <>
            <Note tone="danger">{inviteErrorMessage(active.error)}</Note>
            <Button label="Try again" variant="secondary" onPress={() => void active.refetch()} />
          </>
        ) : null}
        {active.data && activeInfo.total === 0 ? <AppText muted>No active codes. Create one above.</AppText> : null}
        {active.data && activeInfo.total > 0 && activeInfo.page !== activePage ? (
          <GonePage onBack={() => setActivePage(activeInfo.page)} />
        ) : null}
        {(active.data?.rows ?? []).map((code, i) => (
          <View key={code.code}>
            {i > 0 ? <Divider /> : null}
            <CodeRow
              code={code}
              nowMs={nowMs}
              copied={copied === `code:${code.code}`}
              onCopy={() => copy(`code:${code.code}`, code.code)}
              onRevoke={() => setToRevoke(code)}
            />
          </View>
        ))}
        <PageControls
          what="active codes"
          info={activeInfo}
          busy={active.isFetching}
          onPrev={() => setActivePage(Math.max(0, activeInfo.page - 1))}
          onNext={() => setActivePage(activeInfo.page + 1)}
        />
        {revoke.error ? <Note tone="danger">{inviteErrorMessage(revoke.error)}</Note> : null}
      </Card>

      {closedInfo.total > 0 ? (
        <Card>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showClosed }}
            accessibilityLabel={`${showClosed ? 'Hide' : 'Show'} closed codes (${closedInfo.total})`}
            onPress={() => setShowClosed(!showClosed)}
            style={styles.headerRow}>
            <AppText variant="heading">Closed codes</AppText>
            <Badge label={String(closedInfo.total)} />
            <View style={styles.spacer} />
            <AppText variant="small" style={styles.toggle}>{showClosed ? 'Hide' : 'Show'}</AppText>
          </Pressable>
          {showClosed ? (
            <>
              {closed.data && closedInfo.page !== closedPage ? <GonePage onBack={() => setClosedPage(closedInfo.page)} /> : null}
              {(closed.data?.rows ?? []).map((code, i) => (
                <View key={code.code}>
                  {i > 0 ? <Divider /> : null}
                  <CodeRow code={code} nowMs={nowMs} />
                </View>
              ))}
              <PageControls
                what="closed codes"
                info={closedInfo}
                busy={closed.isFetching}
                onPrev={() => setClosedPage(Math.max(0, closedInfo.page - 1))}
                onNext={() => setClosedPage(closedInfo.page + 1)}
              />
            </>
          ) : null}
        </Card>
      ) : null}

      <ConfirmSheet
        visible={toRevoke !== null}
        title="Revoke this code?"
        message={
          toRevoke
            ? `${toRevoke.code} (${inviteTitle(toRevoke)}) will stop working. People who already created an account with it keep their account.`
            : ''
        }
        confirmLabel="Revoke code"
        destructive
        onClose={() => setToRevoke(null)}
        onConfirm={() => {
          if (!toRevoke) return;
          // Revoking the only code of the last page leaves that page empty: go back one page instead of showing nothing.
          const emptiesPage = (active.data?.rows.length ?? 0) === 1 && activePage > 0;
          revoke.mutate(toRevoke.code, { onSuccess: () => emptiesPage && setActivePage(activePage - 1) });
        }}
      />
    </View>
  );
}

/** The page that was open has no codes any more (they were used up, expired or revoked meanwhile). */
function GonePage({ onBack }: { onBack: () => void }) {
  return (
    <>
      <AppText muted>There are no codes on this page any more.</AppText>
      <Button label="Go to the last page" variant="secondary" onPress={onBack} />
    </>
  );
}

/** "1-20 of 137" with Previous / Next; nothing when everything fits on one page. */
function PageControls({
  what,
  info,
  busy,
  onPrev,
  onNext,
}: {
  what: string;
  info: PageInfo;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (info.pageCount <= 1) return null;
  return (
    <View style={styles.pager}>
      <PillButton label="Previous" accessibilityLabel={`Previous page of ${what}`} disabled={!info.hasPrev || busy} onPress={onPrev} />
      <AppText variant="small" muted style={styles.pagerLabel} accessibilityLiveRegion="polite">
        {info.label}
      </AppText>
      <PillButton label="Next" accessibilityLabel={`Next page of ${what}`} disabled={!info.hasNext || busy} onPress={onNext} />
    </View>
  );
}

/** The code that was just made, big, with the e-mail state and the two ways to hand it on. */
function CreatedCode({
  created,
  copied,
  onCopy,
  onDismiss,
}: {
  created: { code: string; email: string; sent: boolean };
  copied: string | null;
  onCopy: (key: string, text: string) => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Card style={{ borderColor: colors.success }}>
      <AppText variant="label" muted>New invite code for {created.email}</AppText>
      <AppText selectable accessibilityLabel={`New invite code ${created.code}`} style={[styles.bigCode, { fontFamily: MONO }]}>
        {created.code}
      </AppText>
      <AppText variant="small" muted>
        {created.sent
          ? `The invite e-mail was sent to ${created.email}.`
          : `The e-mail could not be sent to ${created.email}. Copy the code and send it yourself.`}
      </AppText>
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button label={copied === 'new:code' ? 'Copied' : 'Copy code'} onPress={() => onCopy('new:code', created.code)} />
        </View>
        <View style={styles.flex}>
          <Button
            label={copied === 'new:message' ? 'Copied' : 'Copy message'}
            variant="secondary"
            onPress={() => onCopy('new:message', inviteMessage(created.code))}
          />
        </View>
      </View>
      <Button label="Done" variant="ghost" onPress={onDismiss} />
    </Card>
  );
}

function CodeRow({
  code,
  nowMs,
  copied,
  onCopy,
  onRevoke,
}: {
  code: InviteCode;
  nowMs: number;
  copied?: boolean;
  onCopy?: () => void;
  onRevoke?: () => void;
}) {
  return (
    <View style={styles.codeRow}>
      <View style={styles.flex}>
        <AppText selectable style={[styles.code, { fontFamily: MONO }]}>{code.code}</AppText>
        <AppText variant="body">{inviteTitle(code)}</AppText>
        <AppText variant="small" muted>{inviteDetails(code, nowMs)}</AppText>
      </View>
      {code.status === 'active' ? (
        <View style={styles.actions}>
          {onCopy ? <PillButton label={copied ? 'Copied' : 'Copy'} accessibilityLabel={`Copy code ${code.code}`} onPress={onCopy} /> : null}
          {onRevoke ? <PillButton label="Revoke" accessibilityLabel={`Revoke code ${code.code}`} tone="danger" onPress={onRevoke} /> : null}
        </View>
      ) : (
        <Badge label={inviteStatusLabel(code.status)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.lg },
  field: { gap: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spacer: { flex: 1 },
  toggle: { fontWeight: '700' },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  flex: { flex: 1 },
  code: { fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  bigCode: { fontSize: 26, fontWeight: '700', letterSpacing: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingTop: spacing.sm },
  pagerLabel: { flex: 1, textAlign: 'center' },
});
