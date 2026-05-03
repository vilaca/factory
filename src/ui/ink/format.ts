export function formatArgValue(v: unknown): string {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  const firstLine = str.split('\n')[0];
  const moreLines = str.includes('\n') ? ' …' + (str.split('\n').length - 1) + ' more lines' : '';
  const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
  return truncated + moreLines;
}
