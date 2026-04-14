import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_CHECK_TIMEOUT = 5_000;   // 5s
const LOG_TIMEOUT        = 30_000;  // 30s
const MAX_BUFFER         = 5 * 1024 * 1024; // 5 MB

const FIELD_SEP  = '§§§';
const RECORD_SEP = '†††';

/** A single commit in the log. */
export interface CommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir = searchParams.get('dir');

  if (!dir) {
    return NextResponse.json({ error: 'dir parameter required' }, { status: 400 });
  }

  const rawLimit  = parseInt(searchParams.get('limit')  ?? '50', 10);
  const rawOffset = parseInt(searchParams.get('offset') ?? '0',  10);

  const limit  = isNaN(rawLimit)  || rawLimit  < 1   ? 50  : Math.min(rawLimit, 200);
  const offset = isNaN(rawOffset) || rawOffset < 0   ? 0   : rawOffset;

  // Verify this is a git repository.
  try {
    await execFileAsync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      timeout: REPO_CHECK_TIMEOUT,
    });
  } catch {
    return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
  }

  try {
    // Fetch limit+1 to detect hasMore. Use --shortstat for file-change count.
    // Each commit is prefixed with RECORD_SEP. The --shortstat output appears
    // between commits (after the fields, before the next RECORD_SEP prefix).
    // Layout after split: ['', fields1+stat1, fields2+stat2, ...]
    const format = `--format=${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%B${FIELD_SEP}%an${FIELD_SEP}%aI`;

    const { stdout } = await execFileAsync(
      'git',
      [
        '-C', dir,
        'log',
        `--skip=${offset}`,
        `-n`, `${limit + 1}`,
        '--shortstat',
        format,
      ],
      { timeout: LOG_TIMEOUT, maxBuffer: MAX_BUFFER },
    );

    // Split on RECORD_SEP — each block starts with a commit's formatted fields.
    // Structure per block:
    //   <hash>§§§<shortHash>§§§<subject>§§§<body>§§§<author>§§§<isoDate>\n\n<shortstat>\n
    const rawRecords = stdout.split(RECORD_SEP).filter(s => s.trim());

    const rawCommits = rawRecords.map(block => {
      // Split on FIELD_SEP to extract the 6 fields.
      // parts[5] = "<isoDate>\n\n N file(s) changed, ..."
      const parts = block.split(FIELD_SEP);
      if (parts.length < 6) return null;

      const hash      = parts[0].trim();
      const shortHash = parts[1].trim();
      const subject   = parts[2].trim();
      const message   = parts[3].trim();
      const author    = parts[4].trim();

      // parts[5] = date line + optional blank line + shortstat lines
      const tailLines = parts[5].split('\n').map(l => l.trim()).filter(Boolean);
      const date      = tailLines[0] ?? '';

      // Parse "N file(s) changed" from the remaining lines (shortstat)
      let filesChanged = 0;
      for (let i = 1; i < tailLines.length; i++) {
        const m = tailLines[i].match(/(\d+)\s+files?\s+changed/);
        if (m) {
          filesChanged = parseInt(m[1], 10);
          break;
        }
      }

      if (!hash || !shortHash) return null;

      return { hash, shortHash, subject, message, author, date, filesChanged } satisfies CommitSummary;
    }).filter((c): c is CommitSummary => c !== null);

    const hasMore = rawCommits.length > limit;
    const commits = hasMore ? rawCommits.slice(0, limit) : rawCommits;

    return NextResponse.json({ commits, hasMore });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to retrieve git log';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
