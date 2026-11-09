import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { AppShell } from '@/components/app-nav';
import { useHealthBootstrap } from '@/health/background';

export default function AppLayout() {
  // Loads + validates the on-device OpenRouter key so the AI gate (useAiGate) can open. No-op without a key.
  useAiBootstrap();
  // Incremental Apple Health / Health Connect sync on start + foreground, and background task registration.
  // No-op on web and when no health integration is connected.
  useHealthBootstrap();
  return <AppShell />;
}
