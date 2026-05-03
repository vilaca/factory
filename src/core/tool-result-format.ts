const RESULT_OPEN = '<<TOOL_RESULT';
const RESULT_CLOSE = '<<END_TOOL_RESULT>>';
const RESULT_BLOCK_PATTERN = /<<TOOL_RESULT[^>]*>>[\s\S]*?<<END_TOOL_RESULT>>/g;
const LEGACY_FRAMING_PATTERN = /\[Tool "[^"]+" result\]:/g;

export function formatToolResultMessage(toolName: string, output: string): string {
  return `${RESULT_OPEN} name="${toolName}">>\n${output}\n${RESULT_CLOSE}`;
}

export interface StripResult {
  cleaned: string;
  strippedCount: number;
}

export function stripImitatedToolResults(content: string): StripResult {
  let strippedCount = 0;
  let cleaned = content.replace(RESULT_BLOCK_PATTERN, () => {
    strippedCount++;
    return '';
  });
  cleaned = cleaned.replace(LEGACY_FRAMING_PATTERN, () => {
    strippedCount++;
    return '';
  });
  return {
    cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    strippedCount,
  };
}
