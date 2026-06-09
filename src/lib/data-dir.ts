import os from 'os';
import path from 'path';

export function getCodePilotDataDir(): string {
  return process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
}
