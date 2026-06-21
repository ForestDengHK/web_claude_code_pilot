function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatArtifactDatePath(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatArtifactTimestampForPath(date = new Date()): string {
  return [
    formatArtifactDatePath(date),
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`,
  ].join('-');
}

export function defaultArtifactOutputPath(date = new Date()): string {
  const day = formatArtifactDatePath(date);
  const stamp = formatArtifactTimestampForPath(date);
  return `artifacts-summary/${day}/artifact-digest-${stamp}.html`;
}

export function defaultDashboardEntryPath(date = new Date()): string {
  const day = formatArtifactDatePath(date);
  const stamp = formatArtifactTimestampForPath(date);
  return `artifacts-summary/${day}/dashboard-entry-${stamp}.json`;
}
