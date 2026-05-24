export function formatVerdict(requestId: string, allow: boolean): string {
  return `${allow ? 'allow' : 'deny'}:${requestId}`;
}
