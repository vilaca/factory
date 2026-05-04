import React from 'react';
import { Box, Static } from 'ink';
import type { DisplayItem } from '../types.js';
import type { ToolCallSummary } from '../types.js';
import { DisplayItemView, ToolCallLine } from './display-item-view.js';
import { AssistantText } from './assistant-text.js';
import { Spinner } from './spinner.js';

export interface ConversationDisplayProps {
  items: DisplayItem[];
  streamingText: string;
  /** Tool call rendered live in the dynamic region while we wait for the
   * permission decision / execution to resolve. Once resolved it's flushed
   * into items[] (and thus Static) as the final tool-call entry. */
  pendingToolCall?: ToolCallSummary | null;
  spinner?: { label: string; color: string };
}

/**
 * Items committed to <Static> get written to the terminal once and live in
 * its real scrollback — that's what lets the user scroll up while the model
 * is still streaming. A single outer Box around <Static> wouldn't work
 * (Static items are flushed above any dynamic parent), so each item gets a
 * left-bar accent instead. Visually it reads as one continuous conversation
 * panel without the re-render snapping to the bottom every tick.
 */
function PanelLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} width="100%">
      {children}
    </Box>
  );
}

export function ConversationDisplay({
  items,
  streamingText,
  pendingToolCall,
  spinner,
}: ConversationDisplayProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <PanelLine key={item.id}>
            <DisplayItemView item={item} />
          </PanelLine>
        )}
      </Static>
      {streamingText && (
        <PanelLine>
          <AssistantText text={streamingText} streaming={true} />
        </PanelLine>
      )}
      {pendingToolCall && (
        <PanelLine>
          <ToolCallLine
            icon="🔧"
            toolName={pendingToolCall.toolName}
            args={pendingToolCall.args}
          />
        </PanelLine>
      )}
      {spinner && (
        <PanelLine>
          <Spinner label={spinner.label} color={spinner.color} />
        </PanelLine>
      )}
    </Box>
  );
}
