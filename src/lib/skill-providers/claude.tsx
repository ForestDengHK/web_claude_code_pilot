import { SkillsManager } from '@/components/skills/SkillsManager';
import type { SkillProvider } from './types';

export const claudeSkillProvider: SkillProvider = {
  id: 'claude',
  label: 'Claude',
  capabilities: {
    read: true,
    enableToggle: true,
    edit: true,
    create: true,
  },
  // Claude is the default backend. Always available from the frontend
  // perspective — backend errors still surface inside SkillsManager.
  isAvailable: async () => true,
  ListComponent: SkillsManager,
};
