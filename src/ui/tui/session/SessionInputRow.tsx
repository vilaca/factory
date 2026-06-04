import React from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '../components/text-input.js';
import { Separator } from '../components/separator.js';
import type { TabsContextValue } from '../tabs/TabsContext.js';

interface SessionInputRowProps {
  isActive: boolean;
  tabs: TabsContextValue | null;
  tabLabel?: string;
  showFullOutput: boolean;
  columns?: number;
  inputAccentColor: 'yellow' | 'cyan' | 'green';
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  handleSubmit: (value: string) => void;
  pickerOpen: boolean;
}

export function SessionInputRow({
  isActive,
  tabs,
  tabLabel,
  showFullOutput,
  columns,
  inputAccentColor,
  input,
  setInput,
  handleSubmit,
  pickerOpen,
}: SessionInputRowProps): React.ReactElement | null {
  if (!isActive) return null;
  const totalWaiting = tabs ? tabs.waitingTabs.size : 0;
  const showWaiting = !!tabs && tabs.tabs.length > 1 && totalWaiting > 0;
  const tabPrefix = tabLabel ? `[${tabLabel}]` : '';
  const waitingPrefix = showWaiting ? ` (${totalWaiting} waiting)` : '';
  const outputPrefix = showFullOutput ? ' [full]' : '';
  const prefixWidth = tabPrefix.length + waitingPrefix.length + outputPrefix.length + 2;
  const inputWidth = Math.max(1, (columns ?? 80) - 2 - prefixWidth);
  return (
    <>
      <Separator />
      <Box paddingX={1} width="100%">
        {tabLabel && <Text dimColor>{tabPrefix}</Text>}
        {showWaiting && <Text color="yellow">{waitingPrefix}</Text>}
        {showFullOutput && <Text color="cyan">{outputPrefix}</Text>}
        <Text color={inputAccentColor} bold>
          {'> '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={value => {
            handleSubmit(value);
          }}
          focus={!pickerOpen}
          multiline
          width={inputWidth}
        />
      </Box>
      <Separator />
    </>
  );
}
