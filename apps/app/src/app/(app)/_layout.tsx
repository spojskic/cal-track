import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { AppShell } from '@/components/app-nav';

export default function AppLayout() {
  // Loads + validates the on-device OpenRouter key so the AI gate (useAiGate) can open. No-op without a key.
  useAiBootstrap();
  return <AppShell />;
}
