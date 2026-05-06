import React from 'react';
import { Box, Static } from 'ink';
import type { DisplayItem } from '../types.js';
import type { ToolCallSummary } from '../types.js';
import { DisplayItemView, ToolCallLine } from './display-item-view.js';
import { AssistantText } from './assistant-text.js';
import { Spinner } from './spinner.js';
import { Separator } from './separator.js';

export interface ConversationDisplayProps {
  items: DisplayItem[];
  streamingText: string;
  /** Tool call rendered live in the dynamic region while we wait for the
   * permission decision / execution to resolve. Once resolved it's flushed
   * into items[] (and thus Static) as the final tool-call entry. */
  pendingToolCall?: ToolCallSummary | null;
  spinner?: { label: string; color: string };
  /** Ink only supports one <Static> instance per render tree (its reconciler
   * tracks a single staticNode). With multiple tabs mounted concurrently, we
   * fall back to a plain map for all sessions. Single-tab keeps Static so the
   * existing scrollback UX is preserved. */
  useStatic?: boolean;
  /** When on, tool-result items render the full output instead of the
   * preview. Toggled via /full. */
  showFullOutput?: boolean;
  /** When on, assistant prompt is 🤖 and user prompt is 🧑🏻‍💻. Toggled via /emoji. */
  emojiMode?: boolean;
  /** Custom user emoji from `/emoji <glyph>`. Falls back to 🧑🏻‍💻 when
   *  undefined. Ignored while emojiMode is off. */
  userEmoji?: string;
}

/**
 * Items committed to <Static> get written to the terminal once and live in
 * its real scrollback — that's what lets the user scroll up while the model
 * is still streaming. A single outer Box around <Static> wouldn't work
 * (Static items are flushed above any dynamic parent), so each item gets
 * its own padded Box and turns are split by an inline <Separator />.
 */
function PanelLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box paddingX={1} width="100%">
      {children}
    </Box>
  );
}

export function ConversationDisplay({
  items,
  streamingText,
  pendingToolCall,
  spinner,
  useStatic = true,
  showFullOutput = false,
  emojiMode = false,
  userEmoji,
}: ConversationDisplayProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {useStatic ? (
        <Static items={items}>
          {(item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 && <Separator />}
              <PanelLine>
                <DisplayItemView item={item} showFullOutput={showFullOutput} emojiMode={emojiMode} userEmoji={userEmoji} />
              </PanelLine>
            </React.Fragment>
          )}
        </Static>
      ) : (
        items.map((item, index) => (
          <React.Fragment key={item.id}>
            {index > 0 && <Separator />}
            <PanelLine>
              <DisplayItemView item={item} showFullOutput={showFullOutput} emojiMode={emojiMode} />
            </PanelLine>
          </React.Fragment>
        ))
      )}
      {streamingText && (
        <>
          {items.length > 0 && <Separator />}
          <PanelLine>
            <AssistantText text={streamingText} streaming={true} emojiMode={emojiMode} />
          </PanelLine>
        </>
      )}
      {pendingToolCall && (
        <>
          {items.length > 0 && !streamingText && <Separator />}
          <PanelLine>
            <ToolCallLine
              icon="🔧"
              toolName={pendingToolCall.toolName}
              args={pendingToolCall.args}
            />
          </PanelLine>
        </>
      )}
      {spinner && (
        <>
          {items.length > 0 && !streamingText && !pendingToolCall && <Separator />}
          <PanelLine>
            <Spinner label={spinner.label} color={spinner.color} />
          </PanelLine>
        </>
      )}
    </Box>
  );
}
