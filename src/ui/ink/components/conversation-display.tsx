import React from 'react';
import { Box, Static } from 'ink';
import type { DisplayItem } from '../types.js';
import { DisplayItemView } from './display-item-view.js';
import { AssistantText } from './assistant-text.js';
import { Spinner } from './spinner.js';

export interface ConversationDisplayProps {
  items: DisplayItem[];
  streamingText: string;
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
      {spinner && (
        <PanelLine>
          <Spinner label={spinner.label} color={spinner.color} />
        </PanelLine>
      )}
    </Box>
  );
}
