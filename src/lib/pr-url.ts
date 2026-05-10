export type PrHost = 'github' | 'gitlab' | 'bitbucket';

export interface ParsedPrUrl {
  kind: PrHost;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const GITHUB_RE = /https?:\/\/(?:[\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/i;
const GITLAB_RE = /https?:\/\/(?:[\w.-]+)\/([\w.-/]+?)\/-\/merge_requests\/(\d+)\b/i;
const BITBUCKET_RE = /https?:\/\/bitbucket\.org\/([\w.-]+)\/([\w.-]+)\/pull-requests\/(\d+)\b/i;

export function parsePrUrl(input: string): ParsedPrUrl | null {
  const text = input.trim();
  if (!text) return null;

  const gh = text.match(GITHUB_RE);
  if (gh) {
    return {
      kind: 'github',
      owner: gh[1],
      repo: gh[2],
      number: parseInt(gh[3], 10),
      url: gh[0],
    };
  }

  const bb = text.match(BITBUCKET_RE);
  if (bb) {
    return {
      kind: 'bitbucket',
      owner: bb[1],
      repo: bb[2],
      number: parseInt(bb[3], 10),
      url: bb[0],
    };
  }

  const gl = text.match(GITLAB_RE);
  if (gl) {
    const path = gl[1];
    const segs = path.split('/');
    const owner = segs.slice(0, -1).join('/') || segs[0];
    const repo = segs[segs.length - 1];
    return {
      kind: 'gitlab',
      owner,
      repo,
      number: parseInt(gl[2], 10),
      url: gl[0],
    };
  }

  return null;
}
