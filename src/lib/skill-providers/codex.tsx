import type { SkillProvider } from './types';
import { CodexSkillsList } from '@/components/skills/CodexSkillsList';

async function probeCodex(): Promise<boolean> {
  try {
    const res = await fetch('/api/codex/skills?probe=1', {
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { available?: boolean };
    return data.available === true;
  } catch {
    return false;
  }
}

export const codexSkillProvider: SkillProvider = {
  id: 'codex',
  label: 'Codex',
  capabilities: {
    read: true,
    enableToggle: true,
    edit: true,
    create: true,
  },
  isAvailable: probeCodex,
  ListComponent: CodexSkillsList,
};
