import React from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayItem } from '../types.js';
import { DisplayItemView } from './display-item-view.js';
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
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
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
      {items.length === 0 && !streamingText && !spinner && (
        <Text dimColor>(no output yet — type a prompt below)</Text>
      )}
      <Static items={items}>
        {(item) => (
          <PanelLine key={item.id}>
            <DisplayItemView item={item} />
          </PanelLine>
        )}
      </Static>
      {streamingText && (
        <PanelLine>
          {/* Inline-nested Text so the caret follows the end of the streamed
              text on its actual last line. A row-layout Box places the caret
              at the right edge of the first line, which looks wrong on
              multi-line output. */}
          <Text>{streamingText}<Text color="cyan">▌</Text></Text>
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
